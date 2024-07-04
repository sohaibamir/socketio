import { Adapter, Room } from "socket.io-adapter";
import type { WebSocket as UWebSocket } from "uWebSockets.js";
import { WebSocket as WsWebSocket, Server as WsServer } from "ws"; // New WebSocket Library
import type { Socket } from "./socket.js";
import { createReadStream, statSync } from "fs";
import debugModule from "debug";
import LoggingService from "./LoggingSerivce.js";

const debug = debugModule("socket.io:adapter-extended");

const SEPARATOR = "\x1f"; // see https://en.wikipedia.org/wiki/Delimiter#ASCII_delimited_text

const { addAll, del, broadcast } = Adapter.prototype;

export function patchAdapter(app: any, useWsLibrary = false) {
  Adapter.prototype.addAll = function (id, rooms) {
    const isNew = !this.sids.has(id);
    addAll.call(this, id, rooms);
    const socket: Socket = this.nsp.sockets.get(id);
    if (!socket) {
      return;
    }
    if (useWsLibrary) {
      handleWsLibrary(this.nsp.name, socket, isNew, rooms);
    } else {
      handleUWebSockets(this.nsp.name, socket, isNew, rooms);
    }

    if (isNew) {
      LoggingService.logConnection(this.nsp.name, socket.id); // Log connection
    }
  };

  Adapter.prototype.del = function (id, room) {
    del.call(this, id, room);
    const socket: Socket = this.nsp.sockets.get(id);
    if (socket) {
      if (useWsLibrary) {
        unsubscribeWsLibrary(socket, room);
      } else {
        unsubscribeUWebSockets(socket, room);
      }
    }
  };

  Adapter.prototype.broadcast = function (packet, opts) {
    const useFastPublish = opts.rooms.size <= 1 && opts.except!.size === 0;
    if (!useFastPublish) {
      broadcast.call(this, packet, opts);
      return;
    }

    const flags = opts.flags || {};
    const basePacketOpts = {
      preEncoded: true,
      volatile: flags.volatile,
      compress: flags.compress,
    };

    packet.nsp = this.nsp.name;
    const encodedPackets = this.encoder.encode(packet);

    const topic =
      opts.rooms.size === 0
        ? this.nsp.name
        : `${this.nsp.name}${SEPARATOR}${opts.rooms.keys().next().value}`;
    debug("fast publish to %s", topic);

    encodedPackets.forEach((encodedPacket) => {
      const isBinary = typeof encodedPacket !== "string";
      app.publish(
        topic,
        isBinary ? encodedPacket : "4" + encodedPacket,
        isBinary
      );
    });

    this.apply(opts, (socket) => {
      if (socket.conn.transport.name !== "websocket") {
        socket.client.writeToEngine(encodedPackets, basePacketOpts);
      }
    });
  };
}

function handleUWebSockets(namespaceName: string, socket: Socket, isNew: boolean, rooms: Set<Room>) {
  const sessionId = socket.conn.id;
  const websocket: UWebSocket = socket.conn.transport.socket;
  if (isNew) {
    debug("subscribe connection %s to topic %s", sessionId, namespaceName);
    websocket.subscribe(namespaceName);
  }
  rooms.forEach((room) => {
    const topic = `${namespaceName}${SEPARATOR}${room}`;
    debug("subscribe connection %s to topic %s", sessionId, topic);
    websocket.subscribe(topic);
  });
}

function unsubscribeUWebSockets(socket: Socket, room: Room) {
  const sessionId = socket.conn.id;
  const websocket: UWebSocket = socket.conn.transport.socket;
  const topic = `${socket.nsp.name}${SEPARATOR}${room}`;
  debug("unsubscribe connection %s from topic %s", sessionId, topic);
  websocket.unsubscribe(topic);
}

function handleWsLibrary(namespaceName: string, socket: Socket, isNew: boolean, rooms: Set<Room>) {
  const sessionId = socket.conn.id;
  const websocket: WsWebSocket = socket.conn.transport.socket;
  if (isNew) {
    debug("subscribe connection %s to topic %s", sessionId, namespaceName);
    websocket.subscribe(namespaceName);
  }
  rooms.forEach((room) => {
    const topic = `${namespaceName}${SEPARATOR}${room}`;
    debug("subscribe connection %s to topic %s", sessionId, topic);
    websocket.subscribe(topic);
  });
}

function unsubscribeWsLibrary(socket: Socket, room: Room) {
  const sessionId = socket.conn.id;
  const websocket: WsWebSocket = socket.conn.transport.socket;
  const topic = `${socket.nsp.name}${SEPARATOR}${room}`;
  debug("unsubscribe connection %s from topic %s", sessionId, topic);
  websocket.unsubscribe(topic);
}

export function restoreAdapter() {
  Adapter.prototype.addAll = addAll;
  Adapter.prototype.del = del;
  Adapter.prototype.broadcast = broadcast;
}

const toArrayBuffer = (buffer: Buffer) => {
  const { buffer: arrayBuffer, byteOffset, byteLength } = buffer;
  return arrayBuffer.slice(byteOffset, byteOffset + byteLength);
};

export function serveFile(res /* : HttpResponse */, filepath: string) {
  const { size } = statSync(filepath);
  const readStream = createReadStream(filepath);
  const destroyReadStream = () => !readStream.destroyed && readStream.destroy();

  const onError = (error: Error) => {
    destroyReadStream();
    throw error;
  };

  const onDataChunk = (chunk: Buffer) => {
    const arrayBufferChunk = toArrayBuffer(chunk);

    const lastOffset = res.getWriteOffset();
    const [ok, done] = res.tryEnd(arrayBufferChunk, size);

    if (!done && !ok) {
      readStream.pause();

      res.onWritable((offset) => {
        const [ok, done] = res.tryEnd(
          arrayBufferChunk.slice(offset - lastOffset),
          size
        );

        if (!done && ok) {
          readStream.resume();
        }

        return ok;
      });
    }
  };

  res.onAborted(destroyReadStream);
  readStream
    .on("data", onDataChunk)
    .on("error", onError)
    .on("end", destroyReadStream);
}

