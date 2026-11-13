declare module 'ws' {
  export default class WebSocket {
    constructor(url: string, options?: { headers?: Record<string, string> });
    on(event: 'message', listener: (data: Buffer) => void): void;
    on(event: 'open' | 'error', listener: () => void): void;
    once(event: 'close', listener: (code: number) => void): void;
    send(data: string): void;
    close(): void;
  }
}
