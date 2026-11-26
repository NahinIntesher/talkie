import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

import 'api.dart';
import 'config.dart';

enum Connection { connected, connecting, offline }

/// The live connection to the realtime service (Socket.IO on /ws).
class Realtime {
  Realtime._();
  static final Realtime instance = Realtime._();

  io.Socket? socket;
  final ValueNotifier<Connection> state = ValueNotifier(Connection.connecting);
  int _failures = 0;

  io.Socket connect() {
    if (socket != null) return socket!;
    final s = io.io(
      Config.realtimeUrl,
      io.OptionBuilder()
          .setPath('/ws')
          .setTransports(['websocket'])
          .setAuthFn((callback) => callback({'token': api.accessToken}))
          .setReconnectionDelay(500)
          .setReconnectionDelayMax(8000)
          .enableReconnection()
          .enableForceNew()
          .disableAutoConnect()
          .build(),
    );
    s.onConnect((_) {
      _failures = 0;
      state.value = Connection.connected;
    });
    s.onDisconnect((_) => state.value = Connection.connecting);
    s.onReconnectAttempt((_) => state.value = Connection.connecting);
    s.onConnectError((error) async {
      state.value = Connection.offline;
      // Expired access token: refresh it so the next automatic attempt carries the new one.
      if ('$error'.contains('unauthorized')) {
        await api.refresh?.call();
        return;
      }
      // WebSocket blocked on this network or host: after a few failures, start with long-polling and let it
      // upgrade to WebSocket when that works (the next automatic attempt uses the new order).
      if (++_failures == 3) s.io.options?['transports'] = ['polling', 'websocket'];
    });
    s.connect();
    return socket = s;
  }

  /// Gives the open socket a refreshed access token.
  void renewToken() {
    if (socket?.connected == true && api.accessToken != null) socket!.emit('auth', api.accessToken);
  }

  // Lists are wrapped so the client sends them as one argument instead of spreading them.
  void emit(String event, dynamic data) => socket?.emit(event, data is List ? [data] : data);

  void emitAck(String event, dynamic data, void Function(dynamic) ack) {
    socket?.emitWithAck(event, data is List ? [data] : data, ack: ack);
  }

  void disconnect() {
    socket?.dispose();
    socket = null;
    state.value = Connection.connecting;
  }
}

final realtime = Realtime.instance;
