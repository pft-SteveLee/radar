declare module 'socket.io-client' {
  interface Socket {
    on(event: string, listener: (...args: never[]) => void): Socket;
    once(event: string, listener: (...args: never[]) => void): Socket;
    emit(event: string, ...args: unknown[]): Socket;
    close(): Socket;
  }
  interface Options {
    query?: Record<string, string>;
    transports?: string[];
    extraHeaders?: Record<string, string>;
    reconnection?: boolean;
  }
  export default function io(url: string, options?: Options): Socket;
}
