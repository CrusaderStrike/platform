export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function requestId(): string {
  return `req_${Math.random().toString(16).slice(2, 10)}`;
}
