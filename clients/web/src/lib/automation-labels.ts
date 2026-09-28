/** Human-readable names for automation ids and cron schedules, shared by the sidebar and detail dialog. */

export const automationTitle = (id: string): string => {
  const name = id.replace(/[-_]+/gu, " ");
  return name.charAt(0).toUpperCase() + name.slice(1);
};

export const scheduleLabel = (schedule: string | undefined): string => {
  if (!schedule) return "Scheduled";
  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/u.exec(schedule.trim());
  if (!daily) return schedule;
  const minute = Number(daily[1]);
  const hour = Number(daily[2]);
  if (minute > 59 || hour > 23) return schedule;
  const time = `${hour % 12 || 12}${minute ? `:${String(minute).padStart(2, "0")}` : ""} ${hour < 12 ? "AM" : "PM"}`;
  return `Daily at ${time}`;
};
