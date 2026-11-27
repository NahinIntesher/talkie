import { AccessToken, EgressClient, EncodedFileOutput, RoomServiceClient, StreamOutput, StreamProtocol, TrackSource, WebhookReceiver, S3Upload, type VideoGrant } from 'livekit-server-sdk';
import { AppError, type Logger } from '@talkie/core';

export interface LiveKitEnv {
  LIVEKIT_URL?: string | undefined;
  LIVEKIT_API_KEY?: string | undefined;
  LIVEKIT_API_SECRET?: string | undefined;
  RECORDING_S3_BUCKET?: string | undefined;
  RECORDING_S3_REGION?: string | undefined;
  RECORDING_S3_ENDPOINT?: string | undefined;
  RECORDING_S3_ACCESS_KEY_ID?: string | undefined;
  RECORDING_S3_SECRET_ACCESS_KEY?: string | undefined;
}

export interface Sources {
  camera: boolean;
  microphone: boolean;
  screen: boolean;
  data: boolean;
}

/**
 * The media server (LiveKit Cloud or self-hosted LiveKit). Talkie's services never carry audio or video: they
 * decide who may join and what they may send, and hand out short-lived signed tokens.
 */
export function createLiveKit(env: LiveKitEnv, log: Logger) {
  const configured = !!(env.LIVEKIT_URL && env.LIVEKIT_API_KEY && env.LIVEKIT_API_SECRET);
  const httpUrl = env.LIVEKIT_URL?.replace(/^ws(s?):\/\//, 'http$1://');
  const rooms = configured ? new RoomServiceClient(httpUrl!, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET) : null;
  const egress = configured ? new EgressClient(httpUrl!, env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET) : null;
  const receiver = configured ? new WebhookReceiver(env.LIVEKIT_API_KEY!, env.LIVEKIT_API_SECRET!) : null;

  const require = () => {
    if (!configured) throw new AppError('unavailable', 'Calls and meetings are not set up on this server yet.');
  };

  const sourceList = (sources: Sources) =>
    [sources.camera && TrackSource.CAMERA, sources.microphone && TrackSource.MICROPHONE, sources.screen && TrackSource.SCREEN_SHARE, sources.screen && TrackSource.SCREEN_SHARE_AUDIO].filter(
      (value): value is TrackSource => value !== false,
    );

  /** Best effort: a failed media-server call is logged; Talkie's own state stays the source of truth. */
  const attempt = async (label: string, work: () => Promise<unknown>) => {
    if (!configured) return;
    try {
      await work();
    } catch (error) {
      log.warn({ err: error, action: label }, 'media server call failed');
    }
  };

  return {
    configured,
    url: env.LIVEKIT_URL ?? '',

    async connectedUsers(room: string): Promise<Set<string>> {
      require();
      try {
        return new Set((await rooms!.listParticipants(room)).map((p) => p.identity));
      } catch (error) {
        // A confirmed missing room is empty. Connectivity/auth failures tell us nothing about its participants.
        if ((error as { code?: string }).code === 'not_found') return new Set();
        throw error;
      }
    },

    /** Install check: are the URL, key and secret accepted by the media server? Never returns secrets. */
    async check(): Promise<string> {
      if (!configured) return 'not configured';
      try {
        await Promise.race([rooms!.listRooms(), new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 6000))]);
        return 'ok';
      } catch (error) {
        const message = String((error as Error)?.message ?? error);
        return /401|unauthor|invalid/i.test(message) ? 'rejected: wrong LIVEKIT_API_KEY or LIVEKIT_API_SECRET' : `unreachable: ${message.slice(0, 120)}`;
      }
    },

    async token(input: { room: string; identity: string; name: string; metadata: Record<string, unknown>; sources: Sources; admin?: boolean; ttlSeconds?: number }) {
      require();
      const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
        identity: input.identity,
        name: input.name,
        metadata: JSON.stringify(input.metadata),
        ttl: input.ttlSeconds ?? 6 * 3600,
      });
      const grant: VideoGrant = {
        room: input.room,
        roomJoin: true,
        canSubscribe: true,
        canPublish: input.sources.camera || input.sources.microphone || input.sources.screen,
        canPublishSources: sourceList(input.sources),
        canPublishData: input.sources.data,
        canUpdateOwnMetadata: false,
        roomAdmin: !!input.admin,
      };
      token.addGrant(grant);
      return token.toJwt();
    },

    setPermissions: (room: string, identity: string, sources: Sources) =>
      attempt('updateParticipant', () =>
        rooms!.updateParticipant(room, identity, undefined, {
          canSubscribe: true,
          canPublish: sources.camera || sources.microphone || sources.screen,
          canPublishSources: sourceList(sources),
          canPublishData: sources.data,
          canUpdateMetadata: false,
          hidden: false,
          recorder: false,
          agent: false,
          canSubscribeMetrics: false,
        } as never),
      ),

    /** Mutes every published track of one source (e.g. microphone) for a participant. */
    async mute(room: string, identity: string, source: 'microphone' | 'camera') {
      await attempt('mute', async () => {
        const participant = await rooms!.getParticipant(room, identity);
        const wanted = source === 'microphone' ? TrackSource.MICROPHONE : TrackSource.CAMERA;
        for (const track of participant.tracks) if (track.source === wanted && !track.muted) await rooms!.mutePublishedTrack(room, identity, track.sid, true);
      });
    },

    remove: (room: string, identity: string) => attempt('removeParticipant', () => rooms!.removeParticipant(room, identity)),
    close: (room: string) => attempt('deleteRoom', () => rooms!.deleteRoom(room)),

    /** Small JSON signal to everyone in a room (reactions, "lower your hand"…). */
    broadcast: (room: string, payload: Record<string, unknown>, identities?: string[]) =>
      attempt('sendData', () => rooms!.sendData(room, new TextEncoder().encode(JSON.stringify(payload)), 0 as never, { destinationIdentities: identities, topic: 'talkie' })),

    recordingAvailable: configured && !!env.RECORDING_S3_BUCKET,

    async startRecording(room: string, fileName: string) {
      require();
      if (!env.RECORDING_S3_BUCKET) throw new AppError('unavailable', 'Recording needs cloud storage. Add RECORDING_S3_* settings on the server.');
      const output = new EncodedFileOutput({
        filepath: `recordings/${fileName}.mp4`,
        output: {
          case: 's3',
          value: new S3Upload({
            bucket: env.RECORDING_S3_BUCKET,
            region: env.RECORDING_S3_REGION ?? 'auto',
            endpoint: env.RECORDING_S3_ENDPOINT ?? '',
            accessKey: env.RECORDING_S3_ACCESS_KEY_ID ?? '',
            secret: env.RECORDING_S3_SECRET_ACCESS_KEY ?? '',
            forcePathStyle: !!env.RECORDING_S3_ENDPOINT,
          }),
        },
      });
      const info = await egress!.startRoomCompositeEgress(room, { file: output }, { layout: 'grid' });
      return info.egressId;
    },

    async startStream(room: string, rtmpUrl: string) {
      require();
      const info = await egress!.startRoomCompositeEgress(room, { stream: new StreamOutput({ protocol: StreamProtocol.RTMP, urls: [rtmpUrl] }) }, { layout: 'speaker' });
      return info.egressId;
    },

    stopEgress: (egressId: string) => attempt('stopEgress', () => egress!.stopEgress(egressId)),

    async verifyWebhook(body: string, authorization: string | undefined) {
      if (!receiver) throw new AppError('unavailable', 'Not configured.');
      return receiver.receive(body, authorization);
    },
  };
}

export type LiveKit = ReturnType<typeof createLiveKit>;
