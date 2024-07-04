import type { BroadcastFlags, Room, SocketId } from "socket.io-adapter";
import { Handshake, RESERVED_EVENTS, Socket } from "./socket";
import { PacketType } from "socket.io-parser";
import type { Adapter } from "socket.io-adapter";
import type {
  EventParams,
  EventNames,
  EventsMap,
  TypedEventBroadcaster,
  DecorateAcknowledgements,
  AllButLast,
  Last,
  FirstNonErrorArg,
  EventNamesWithError,
} from "./typed-events";

// Original BroadcastOperator class
export class BroadcastOperator<EmitEvents extends EventsMap, SocketData>
  implements TypedEventBroadcaster<EmitEvents>
{
  constructor(
    private readonly adapter: Adapter,
    private readonly rooms: Set<Room> = new Set<Room>(),
    private readonly exceptRooms: Set<Room> = new Set<Room>(),
    private readonly flags: BroadcastFlags & {
      expectSingleResponse?: boolean;
    } = {}
  ) {}

  public to(room: Room | Room[]) {
    const rooms = new Set(this.rooms);
    if (Array.isArray(room)) {
      room.forEach((r) => rooms.add(r));
    } else {
      rooms.add(room);
    }
    return new BroadcastOperator<EmitEvents, SocketData>(
      this.adapter,
      rooms,
      this.exceptRooms,
      this.flags
    );
  }

  public in(room: Room | Room[]) {
    return this.to(room);
  }

  public except(room: Room | Room[]) {
    const exceptRooms = new Set(this.exceptRooms);
    if (Array.isArray(room)) {
      room.forEach((r) => exceptRooms.add(r));
    } else {
      exceptRooms.add(room);
    }
    return new BroadcastOperator<EmitEvents, SocketData>(
      this.adapter,
      this.rooms,
      exceptRooms,
      this.flags
    );
  }

  public compress(compress: boolean) {
    const flags = Object.assign({}, this.flags, { compress });
    return new BroadcastOperator<EmitEvents, SocketData>(
      this.adapter,
      this.rooms,
      this.exceptRooms,
      flags
    );
  }

  public get volatile() {
    const flags = Object.assign({}, this.flags, { volatile: true });
    return new BroadcastOperator<EmitEvents, SocketData>(
      this.adapter,
      this.rooms,
      this.exceptRooms,
      flags
    );
  }

  public get local() {
    const flags = Object.assign({}, this.flags, { local: true });
    return new BroadcastOperator<EmitEvents, SocketData>(
      this.adapter,
      this.rooms,
      this.exceptRooms,
      flags
    );
  }

  public timeout(timeout: number) {
    const flags = Object.assign({}, this.flags, { timeout });
    return new BroadcastOperator<
      DecorateAcknowledgements<EmitEvents>,
      SocketData
    >(this.adapter, this.rooms, this.exceptRooms, flags);
  }

  public emit<Ev extends EventNames<EmitEvents>>(
    ev: Ev,
    ...args: EventParams<EmitEvents, Ev>
  ): boolean {
    if (RESERVED_EVENTS.has(ev)) {
      throw new Error(`"${String(ev)}" is a reserved event name`);
    }
    const data = [ev, ...args];
    const packet = {
      type: PacketType.EVENT,
      data: data,
    };

    const withAck = typeof data[data.length - 1] === "function";

    if (!withAck) {
      this.adapter.broadcast(packet, {
        rooms: this.rooms,
        except: this.exceptRooms,
        flags: this.flags,
      });

      return true;
    }

    const ack = data.pop() as (...args: any[]) => void;
    let timedOut = false;
    let responses: any[] = [];

    const timer = setTimeout(() => {
      timedOut = true;
      ack.apply(this, [
        new Error("operation has timed out"),
        this.flags.expectSingleResponse ? null : responses,
      ]);
    }, this.flags.timeout);

    let expectedServerCount = -1;
    let actualServerCount = 0;
    let expectedClientCount = 0;

    const checkCompleteness = () => {
      if (
        !timedOut &&
        expectedServerCount === actualServerCount &&
        responses.length === expectedClientCount
      ) {
        clearTimeout(timer);
        ack.apply(this, [
          null,
          this.flags.expectSingleResponse ? responses[0] : responses,
        ]);
      }
    };

    this.adapter.broadcastWithAck(
      packet,
      {
        rooms: this.rooms,
        except: this.exceptRooms,
        flags: this.flags,
      },
      (clientCount) => {
        expectedClientCount += clientCount;
        actualServerCount++;
        checkCompleteness();
      },
      (clientResponse) => {
        responses.push(clientResponse);
        checkCompleteness();
      }
    );

    this.adapter.serverCount().then((serverCount) => {
      expectedServerCount = serverCount;
      checkCompleteness();
    });

    return true;
  }

  public emitWithAck<Ev extends EventNamesWithError<EmitEvents>>(
    ev: Ev,
    ...args: AllButLast<EventParams<EmitEvents, Ev>>
  ): Promise<FirstNonErrorArg<Last<EventParams<EmitEvents, Ev>>>> {
    return new Promise((resolve, reject) => {
      args.push((err, responses) => {
        if (err) {
          err.responses = responses;
          return reject(err);
        } else {
          return resolve(responses);
        }
      });
      this.emit(ev, ...(args as any[] as EventParams<EmitEvents, Ev>));
    });
  }

  public allSockets(): Promise<Set<SocketId>> {
    if (!this.adapter) {
      throw new Error(
        "No adapter for this namespace, are you trying to get the list of clients of a dynamic namespace?"
      );
    }
    return this.adapter.sockets(this.rooms);
  }

  public fetchSockets(): Promise<RemoteSocket<EmitEvents, SocketData>[]> {
    return this.adapter
      .fetchSockets({
        rooms: this.rooms,
        except: this.exceptRooms,
        flags: this.flags,
      })
      .then((sockets) => {
        return sockets.map((socket) => {
          if (socket instanceof Socket) {
            return socket as unknown as RemoteSocket<EmitEvents, SocketData>;
          } else {
            return new RemoteSocket(
              this.adapter,
              socket as SocketDetails<SocketData>
            );
          }
        });
      });
  }

  public socketsJoin(room: Room | Room[]): void {
    this.adapter.addSockets(
      {
        rooms: this.rooms,
        except: this.exceptRooms,
        flags: this.flags,
      },
      Array.isArray(room) ? room : [room]
    );
  }

  public socketsLeave(room: Room | Room[]): void {
    this.adapter.delSockets(
      {
        rooms: this.rooms,
        except: this.exceptRooms,
        flags: this.flags,
      },
      Array.isArray(room) ? room : [room]
    );
  }

  public disconnectSockets(close: boolean = false): void {
    this.adapter.disconnectSockets(
      {
        rooms: this.rooms,
        except: this.exceptRooms,
        flags: this.flags,
      },
      close
    );
  }
}

interface SocketDetails<SocketData> {
  id: SocketId;
  handshake: Handshake;
  rooms: Room[];
  data: SocketData;
}

export class RemoteSocket<EmitEvents extends EventsMap, SocketData>
  implements TypedEventBroadcaster<EmitEvents>
{
  public readonly id: SocketId;
  public readonly handshake: Handshake;
  public readonly rooms: Set<Room>;
  public readonly data: SocketData;

  private readonly operator: BroadcastOperator<EmitEvents, SocketData>;

  constructor(adapter: Adapter, details: SocketDetails<SocketData>) {
    this.id = details.id;
    this.handshake = details.handshake;
    this.rooms = new Set(details.rooms);
    this.data = details.data;
    this.operator = new BroadcastOperator<EmitEvents, SocketData>(
      adapter,
      new Set([this.id]),
      new Set(),
      {
        expectSingleResponse: true,
      }
    );
  }

  public timeout(
    timeout: number
  ): BroadcastOperator<DecorateAcknowledgements<EmitEvents>, SocketData> {
    return this.operator.timeout(timeout);
  }

  public emit<Ev extends EventNames<EmitEvents>>(
    ev: Ev,
    ...args: EventParams<EmitEvents, Ev>
  ): boolean {
    return this.operator.emit(ev, ...args);
  }

  public join(room: Room | Room[]): void {
    return this.operator.socketsJoin(room);
  }

  public leave(room: Room): void {
    return this.operator.socketsLeave(room);
  }

  public disconnect(close = false): this {
    this.operator.disconnectSockets(close);
    return this;
  }
}

// Logging extension using Proxy Pattern
class LoggingBroadcastOperator<EmitEvents extends EventsMap, SocketData> extends BroadcastOperator<EmitEvents, SocketData> {
  constructor(
    private readonly wrapped: BroadcastOperator<EmitEvents, SocketData>
  ) {
    super(wrapped['adapter'], wrapped['rooms'], wrapped['exceptRooms'], wrapped['flags']);
  }

  public emit<Ev extends EventNames<EmitEvents>>(
    ev: Ev,
    ...args: EventParams<EmitEvents, Ev>
  ): boolean {
    console.log(`Event "${ev}" is being emitted with args:`, args);
    return this.wrapped.emit(ev, ...args);
  }
}

// Compression extension using Proxy Pattern
class CompressionBroadcastOperator<EmitEvents extends EventsMap, SocketData> extends BroadcastOperator<EmitEvents, SocketData> {
  constructor(
    private readonly wrapped: BroadcastOperator<EmitEvents, SocketData>
  ) {
    super(wrapped['adapter'], wrapped['rooms'], wrapped['exceptRooms'], wrapped['flags']);
  }

  public emit<Ev extends EventNames<EmitEvents>>(
    ev: Ev,
    ...args: EventParams<EmitEvents, Ev>
  ): boolean {
    this.wrapped.compress(true);
    return this.wrapped.emit(ev, ...args);
  }
}

// Access Control extension using Proxy Pattern
class AccessControlBroadcastOperator<EmitEvents extends EventsMap, SocketData> extends BroadcastOperator<EmitEvents, SocketData> {
  constructor(
    private readonly wrapped: BroadcastOperator<EmitEvents, SocketData>,
    private readonly userRole: string
  ) {
    super(wrapped['adapter'], wrapped['rooms'], wrapped['exceptRooms'], wrapped['flags']);
  }

  private hasPermission(): boolean {
    // Example permission check based on role
    return this.userRole === 'admin';
  }

  public emit<Ev extends EventNames<EmitEvents>>(
    ev: Ev,
    ...args: EventParams<EmitEvents, Ev>
  ): boolean {
    if (this.hasPermission()) {
      return this.wrapped.emit(ev, ...args);
    } else {
      console.warn(`User with role "${this.userRole}" does not have permission to emit event "${ev}"`);
      return false;
    }
  }
}

// Example usage of the BroadcastOperator with various extensions
const broadcastOperator = new BroadcastOperator(adapter);

// Create an access control proxy for a user with 'admin' role
const adminBroadcastOperator = new AccessControlBroadcastOperator(broadcastOperator, 'admin');

// Create an access control proxy for a user with 'user' role
const userBroadcastOperator = new AccessControlBroadcastOperator(broadcastOperator, 'user');

// Emit an event as admin (allowed)
adminBroadcastOperator.to("room-101").emit("foo", "bar");

// Emit an event as user (not allowed)
userBroadcastOperator.to("room-101").emit("foo", "bar");

// Wrap with logging
const loggingBroadcastOperator = new LoggingBroadcastOperator(adminBroadcastOperator);

// Wrap with compression
const compressionBroadcastOperator = new CompressionBroadcastOperator(loggingBroadcastOperator);

// Emit an event with logging and compression
compressionBroadcastOperator.to("room-101").emit("foo", "bar");
