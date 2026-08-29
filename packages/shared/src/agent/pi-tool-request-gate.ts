export class PiToolRequestGate {
  private credential: string | null = null;
  private nextSequence = 1;

  activate(credential: string): void {
    if (!credential) throw new TypeError('Tool request credential must be a non-empty string');
    this.credential = credential;
    this.nextSequence = 1;
  }

  revoke(): void {
    this.credential = null;
    this.nextSequence = 1;
  }

  accept(credential: string, sequence: number): boolean {
    if (
      this.credential === null
      || credential !== this.credential
      || !Number.isSafeInteger(sequence)
      || sequence !== this.nextSequence
    ) return false;

    this.nextSequence += 1;
    return true;
  }
}
