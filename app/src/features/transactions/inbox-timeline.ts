// Lay inbox questions out as a timeline: a day label in the left rail once per day, and a trip band joining
// the questions of one trip. Pure and view-side only (R2): the trip itself is the server's verdict
// (/api/inbox/context); this only decides where the labels and the band go.

const DOW = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;

/** One question placed on the timeline. */
export interface TimelineEntry<Q> {
  readonly question: Q;
  /** The question's day, YYYY-MM-DD. */
  readonly day: string;
  /** First question of its day: the rail shows the day label. */
  readonly showDay: boolean;
  /** "SUN" … "SAT". */
  readonly weekday: string;
  /** Day of month, no leading zero. */
  readonly dayOfMonth: string;
  /** The trip's "City, ST", or null. */
  readonly trip: string | null;
  /** First question of a run on one trip: the band's label goes above it. */
  readonly tripStart: boolean;
}

/** Place questions (already newest first) on the timeline, given each one's day and trip. */
export const timelineOf = <Q>(
  questions: readonly Q[],
  dayOf: (question: Q) => string,
  tripOf: (question: Q) => string | null,
): readonly TimelineEntry<Q>[] => {
  let previousDay: string | null = null;
  let previousTrip: string | null = null;
  return questions.map((question) => {
    const day = dayOf(question).slice(0, 10);
    const trip = tripOf(question);
    const date = new Date(`${day}T00:00:00Z`);
    const entry: TimelineEntry<Q> = {
      question,
      day,
      showDay: day !== previousDay,
      weekday: DOW[date.getUTCDay()],
      dayOfMonth: String(date.getUTCDate()),
      trip,
      tripStart: trip !== null && trip !== previousTrip,
    };
    previousDay = day;
    previousTrip = trip;
    return entry;
  });
};
