/**
 * Type declarations for JsDataflashParser
 * https://github.com/Williangalvani/JsDataflashParser
 */

export interface MessageType {
  expressions: string[];
  units?: string[];
  multipliers?: number[];
  complexFields: Record<string, {
    name: string;
    units: string;
    multiplier: number;
  }>;
  instances?: Record<number, string>;
}

export interface ParsedMessages {
  [messageName: string]: {
    time_boot_ms: Float64Array;
    [field: string]: Float64Array | string[] | number[];
  };
}

export interface ParseResult {
  types: Record<string, MessageType>;
  messages: ParsedMessages;
}

export interface LogStats {
  [messageName: string]: {
    count: number;
    msg_size: number;
    size: number;
  };
}

declare class DataflashParser {
  constructor(send_postMessage?: boolean);

  buffer: ArrayBuffer | null;
  data: DataView | null;
  messages: ParsedMessages;
  messageTypes: Record<string, MessageType>;
  FMT: any[];

  /** Parse a binary dataflash log buffer */
  processData(data: ArrayBuffer, msgs?: string[]): ParseResult;

  /** Get parsed data for a message type, optionally a single field */
  get(name: string, field?: string): any;

  /** Get parsed data for a specific instance of a message type */
  get_instance(name: string, instance: number | null, field?: string): any;

  /** Parse a specific message type from the already-loaded buffer */
  parseAtOffset(name: string): void;

  /** Load and parse a specific message type */
  loadType(type: string): void;

  /** Extract the GPS start time from the log */
  extractStartTime(): Date | undefined;

  /** Get statistics about log composition */
  stats(): LogStats;

  /** Get mode string for a mode number */
  getModeString(cmode: number): string;
}

export default DataflashParser;
