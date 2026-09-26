-- minimalDASH's early jobs data is thrown away, at the owner's request (2026-09-26): "this data is useless". DASH data is disposable and
-- nothing in the books refers to it (see 20261014000100_dash_projects.sql), so this touches no book. The tables stay: the Gmail add-on
-- still files into them. Files in Google Drive are not affected (only their links were kept here).

delete from public.dash_events;
delete from public.dash_parts;
delete from public.dash_jobs;
