-- Little Ones' icon in the bell list and phone alerts: 🧑‍🧑‍🧒 (was 👶). Same as 20261125000000_little_ones.sql otherwise. Safe to re-run.

create or replace function _notify_title(p_app text, p_event uuid, out o_code text, out o_title text, out o_emoji text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_app = 'rsvp' then select code, title, emoji into o_code, o_title, o_emoji from rsvp_events where id = p_event;
  elsif p_app = 'wdw' then select code, name, '📅' into o_code, o_title, o_emoji from events where id = p_event;
  elsif p_app = 'poll' then select code, name, '🗳️' into o_code, o_title, o_emoji from polls where id = p_event;
  elsif p_app = 'signup' then select code, coalesce(nullif(state->>'title', ''), 'Sign-up Sheet'), '📋' into o_code, o_title, o_emoji from plan_docs where id = p_event;
  elsif p_app = 'santa' then select code, name, '🎁' into o_code, o_title, o_emoji from santa_groups where id = p_event;
  elsif p_app = 'basecamp' then select code, name, '⛺' into o_code, o_title, o_emoji from bc_sessions where id = p_event;
  elsif p_app = 'bracket' then select code, coalesce(nullif(state->>'title', ''), 'Bracket'), '🏆' into o_code, o_title, o_emoji from play_games where id = p_event;
  elsif p_app = 'little' then select code, coalesce(nullif(state->'lo'->>'baby', ''), 'Little Ones'), '🧑‍🧑‍🧒' into o_code, o_title, o_emoji from plan_docs where id = p_event;
  end if;
end $$;
