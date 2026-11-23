import type { Routine, WorkoutSession } from '@wom/core';

export interface Storage {
  listRoutines(): Promise<Routine[]>;
  saveRoutine(r: Routine): Promise<void>;
  deleteRoutine(id: string): Promise<void>;
  listSessions(): Promise<WorkoutSession[]>;
  getSession(id: string): Promise<WorkoutSession | null>;
  /** id 기준 덮어쓰기(upsert) */
  saveSession(s: WorkoutSession): Promise<void>;
}
