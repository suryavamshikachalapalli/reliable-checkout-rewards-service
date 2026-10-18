export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ApiError(400, 'INVALID_INPUT', `${name} must be a positive safe integer.`);
  }
  return value;
}

export function id(value: string, name: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new ApiError(400, 'INVALID_INPUT', `${name} must be a positive safe integer.`);
  }
  return positiveInteger(Number(value), name);
}

export function safeTotal(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ApiError(400, 'TOTAL_OUT_OF_RANGE', 'Cart totals exceed the safe integer range.');
  }
  return value;
}

