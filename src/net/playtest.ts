export type PlaytestAccess = { server: string; key: string };
let access: PlaytestAccess | undefined;
export function enablePlaytest(value: PlaytestAccess): void { access = value; }
export function playtestAccess(): PlaytestAccess | undefined { return access; }
