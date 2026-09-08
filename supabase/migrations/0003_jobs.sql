-- Pro Aid · scheduled jobs on Supabase (pg_cron). Runs the morning reminders at 09:00 Pakistan time (04:00 UTC).
create extension if not exists pg_cron;
do $$
begin
  perform cron.unschedule('proaid-daily-jobs');
exception when others then null;
end $$;
select cron.schedule('proaid-daily-jobs', '0 4 * * *', $$select public.run_daily_jobs()$$);
-- reminders set for a specific time of day are checked every 15 minutes
do $$
begin
  perform cron.unschedule('proaid-reminders');
exception when others then null;
end $$;
select cron.schedule('proaid-reminders', '*/15 * * * *', $$select public.run_daily_jobs()$$);
