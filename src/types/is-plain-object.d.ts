declare module 'is-plain-object' {
  export function isPlainObject(value: unknown): value is Record<string, unknown>;
}
