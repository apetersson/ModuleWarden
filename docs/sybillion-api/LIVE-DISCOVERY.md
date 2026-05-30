# Live discovery: what real API calls revealed

Run against the live API with our own key on 2026-05-30, authorized, spending
trial credit. These are measured numbers from real responses, and several
correct claims we had carried from docs examples. Numbers come from a run, never
invented.

## The cost correction (the important one)

We had carried "a forecast settles at about 3 EUR cents" from the docs `jobs.md`
EXAMPLE. That is wrong as our number. Real settled charges from `GET /usage`:

| Endpoint | Real charge | Notes |
|---|---|---|
| forecast | 0.35 EUR (date-fns); 1.26-1.82 EUR on other runs | varies with series length / horizon / backtest; credits ~ 71-364 |
| drivers (default limit) | 4.85 EUR | billed ~1 credit per driver, ~970 drivers returned |
| alerts | 0.06 EUR | cheap; this is the trigger we lean on |

So the budget math changes: at roughly 0.35-1.80 EUR per forecast, the 26.59 EUR
trial is about 15-70 forecasts, NOT ~880. A single unbounded drivers call eats
about a fifth of the trial. The alert trigger is the cheap part.

Implication for the pitch: forecast only the deps that clear the history floor,
and only on an alert trigger; never call the broad drivers endpoint live; if we
ever call drivers, set `filters.limit` low.

## The quantile set (CONFIRM-LIVE resolved)

`forecast.json` returns 19 quantiles, 0.05 to 0.95 in 0.05 steps, not the docs'
0.1/0.5/0.9 example. Confirmed on the date-fns run. Our interval roll-up and
band-routing have a far richer surface than the docs implied. The backtest
metric keys are uppercase: MAE, MAPE, MASE, RMSE, RMSSE.

## The honesty number (real backtest MAPE)

date-fns, 88 monthly points (2019-01 to 2026-04), 6-month horizon, backtest on:

- 6-month window MAPE: 27.89 percent. The 12/24/60m windows echo the same single
  fold for a 6-month horizon, so the load-bearing number is the 6m MAPE.

This is a good honest result, not a cherry-picked flat series: a mid-tier climber
gives a real ~28 percent six-month error. We show it; it is exactly why the gate,
not the forecast, owns the verdict.

The contrast run makes the point: lodash (a flat high-volume giant, 100 monthly
points) settled at a 6-month MAPE of 15.64 percent, lower than date-fns at 27.89.
The forecast is tighter on the smooth series and looser on the volatile climber,
exactly as it should be, and we show both rather than only the easy one. That is
the answer to "you cherry-picked a smooth package": no, here is the harder one
and its worse number.

## Drivers are macro noise for software (kills the driver-injection idea)

`POST /drivers` for a date-fns adoption series with software keywords (npm,
javascript, open source, developer adoption) returned 970 drivers, all of the
form "Global risk - <country>" (United Kingdom, United States, Germany, Israel,
China, World), scores 0.94-0.96. No software-relevant signal. So the
driver-injection demo (old move 3) is not credible for npm and is dropped. The
driver lake is built for commodity and macro series, not software adoption.

## Operational notes

- A forecast job can take over two minutes (lodash at 100 monthly points was
  still running past the old 120s poll window). The feeder poll window is raised
  to six minutes.
- A forecast places a worst-case balance HOLD of up to 5.00 EUR while running,
  released and replaced by the actual (smaller) charge on settle. So
  `available_eur_cents` dips by the hold mid-run, then recovers.
- Liveness proof on stage: the response `job_id` is real and queryable; the
  `created_at` was null in the submit body, so read it from `GET /forecasts/:id`
  or `GET /jobs` for the timestamp.

## Account correction (read this first)

The numbers in the "stranded tail" and spend sections below were measured against
a PERSONAL 50 EUR signup-trial account, reached via the stale `SYBILION_API_KEY`
that was in `keys.txt`. That is NOT the hackathon account. The real hackathon
account (a different key) holds a 10,000 EUR `hackathon_zero_one_2026` grant at
tier 4 (verified live 2026-05-30, balance ~10,040 EUR, expires 2026-06-02).
`keys.txt` has been repointed to the hackathon key. So the "91 percent used / hard
floor" framing applies only to the depleted trial sub-account; the hackathon
credit is effectively unlimited for this work, and the large forecast run happens
on it. The hold-ceiling mechanic below is still a real API behavior, it just was
not the real constraint.

## The credit has a stranded tail (the hold ceiling)

You cannot spend trial credit down to zero on forecasts. `POST /forecasts`
reserves a worst-case HOLD of up to 5.00 EUR before running, and if
`available_eur_cents` is below that ceiling the submit is rejected with `402
Payment Required`, even though the actual settle would be ~1 EUR. We hit this at
4.57 EUR remaining: four 12-month-horizon forecasts all returned 402. So the
last ~5 EUR of a trial grant is stranded behind the per-forecast hold until a
top-up lifts the balance back over the ceiling. We used 45.43 of the 50 EUR
grant (about 91 percent); the remainder is locked, not unspent by choice.

## Spend this session

About 5.20 EUR of trial credit (4.85 of it the one drivers call, 0.35 the
date-fns forecast), plus a 5.00 EUR hold on the running lodash job. Stopped
submitting once the findings were banked rather than draining the trial on
repetition.
