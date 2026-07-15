export class CreateOperationIdentity {
  #intent: string | null = null;
  #operationId: string | null = null;
  readonly #createId: () => string;

  constructor(createId: () => string = () => crypto.randomUUID()) {
    this.#createId = createId;
  }

  operationIdFor(intent: unknown): string {
    const nextIntent = JSON.stringify(intent);
    if (this.#operationId === null || this.#intent !== nextIntent) {
      this.#intent = nextIntent;
      this.#operationId = this.#createId();
    }
    return this.#operationId;
  }

  hasActiveOperation(): boolean {
    return this.#operationId !== null;
  }

  invalidateIfIntentChanged(intent: unknown): boolean {
    if (this.#operationId === null || this.#intent === JSON.stringify(intent)) {
      return false;
    }
    this.invalidate();
    return true;
  }

  invalidate(): void {
    this.#intent = null;
    this.#operationId = null;
  }
}

export function canonicalCollapsedCreateName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
