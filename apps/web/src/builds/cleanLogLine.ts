/* eslint-disable no-control-regex */
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/g;
const OTHER_ESCAPE = /\u001b[ -/]*[0-~]?/g;
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;

/** Build output as plain text: colours, cursor moves and title changes go, and tabs stay. React escapes the rest. */
export function cleanLogLine(line: string): string {
  return line.replace(OSC, '').replace(CSI, '').replace(OTHER_ESCAPE, '').replace(CONTROL, '');
}
