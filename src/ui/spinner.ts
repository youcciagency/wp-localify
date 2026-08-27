import { spinner as clackSpinner } from "@clack/prompts";

type ClackSpinner = ReturnType<typeof clackSpinner>;

let activeSpinner: ClackSpinner | undefined;

export interface TrackedSpinner {
  start(message: string): void;
  message(message: string): void;
  stop(message?: string): void;
}

class Tracked implements TrackedSpinner {
  private readonly spinner: ClackSpinner;

  constructor() {
    this.spinner = clackSpinner();
    activeSpinner = this.spinner;
  }

  start(message: string): void {
    this.spinner.start(message);
  }

  message(message: string): void {
    this.spinner.message(message);
  }

  stop(message = ""): void {
    if (activeSpinner === this.spinner) {
      activeSpinner = undefined;
    }
    this.spinner.stop(message);
  }
}

export function startSpinner(label: string): TrackedSpinner {
  const tracked = new Tracked();
  tracked.start(label);
  return tracked;
}

export function stopActiveSpinner(message = ""): void {
  const spinner = activeSpinner;
  activeSpinner = undefined;
  try {
    spinner?.stop(message);
  } catch {
    // spinner may already be finalized; nothing to do
  }
}
