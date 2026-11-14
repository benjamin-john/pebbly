-- Basecamp + OwnTracks: no automatic screen-off trails. Trails are only recorded when someone taps Trail (and with
-- screen-off sharing on, that trail carries on through OwnTracks: bc_ot_follow). The "record my trail while the screen
-- is off" option is gone from the page, so switch it off for everyone (20261117020000 had switched it on). Safe to re-run.

update bc_members set ot_trail = false, ot_trail_id = null where ot_trail;
