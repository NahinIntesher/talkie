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

  io.Socket connect() {
    if (socket != null) return socket!;
    final s = io.io(
      Config.realtimeUrl,
      io.OptionBuilder()
          .setPath('/ws')
          .setTransports(['websocket'])
          .setAuthFn((callback) => callback({'token': api.accessToken}))
          .setTimeout(8000)
          .setReconnectionDelay(500)
          .setReconnectionDelayMax(8000)
          .enableReconnection()
          .enableForceNew()
          .disableAutoConnect()
          .build(),
    );
    var retriedAuthorization = false;
    s.onConnect((_) {
      retriedAuthorization = false;
      state.value = Connection.connected;
    });
    s.onDisconnect((_) => state.value = Connection.offline);
    s.onConnectError((error) async {
      state.value = Connection.offline;
      // A server-denied handshake closes this Socket.IO subscription and needs an explicit reconnect.
      if (!retriedAuthorization && '$error'.contains('unauthorized')) {
        retriedAuthorization = true;
        if (await api.refresh?.call() == true && identical(socket, s)) s.connect();
      }
    });
    s.onReconnectFailed((_) => state.value = Connection.offline);
    socket = s;
    s.connect();
    return s;
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
