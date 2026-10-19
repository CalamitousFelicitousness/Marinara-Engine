// Dated Professor Mari looks. Inside its window a seasonal appearance pack shows by itself (the user can still
// pick another) and Mari's voice gets a light matching flavor; outside it the pack is hidden everywhere.
// Windows are inclusive local "MM-DD" dates.
export interface MariSeason {
  from: string;
  to: string;
}

export const MARI_RACCOON_SEASON: MariSeason = { from: "10-29", to: "11-01" };

const monthDay = (now: Date) =>
  `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

// ponytail: string compare, so a window cannot wrap New Year; split it in two if one ever must.
export function isInMariSeason(season: MariSeason, now: Date = new Date()): boolean {
  const today = monthDay(now);
  return today >= season.from && today <= season.to;
}
