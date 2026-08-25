const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BRAND_ID = '2432911154364948480';
const MATCH_BETTING_URL = 'https://csgoempire.com/match-betting';
const TENNIS_SPORT_ID = '5';
const CS2_SPORT_ID = '109';
const FOOTBALL_SPORT_ID = '1';
const BASKETBALL_SPORT_ID = '2';
const BASEBALL_SPORT_ID = '3';

function getArg(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find(a => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasArg(name) {
  return process.argv.includes(`--${name}`);
}

const WAIT_MS = Number(getArg('wait', '18000'));
const HOURS_AHEAD = Number(getArg('hours', '24'));
const OUT_FILE = path.resolve(getArg('out', 'betting-odds.json'));
const HEADLESS = hasArg('headless');
const INCLUDE_RAW = hasArg('include-raw');
const ONLY = String(getArg('only', 'all')).toLowerCase();
const CONCURRENCY = Math.max(1, Number(getArg('concurrency', '8')) || 8);

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(target, source) {
  if (!isObject(source)) return source;
  if (!isObject(target)) target = {};

  for (const [key, value] of Object.entries(source)) {
    if (value === null) {
      delete target[key];
      continue;
    }

    if (isObject(value)) {
      target[key] = deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }

  return target;
}

function toOdd(entry) {
  if (!entry || entry.b === 1) return null;
  const n = Number(entry.k);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function brazilTime(unixSeconds) {
  if (!unixSeconds) return null;

  try {
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      dateStyle: 'short',
      timeStyle: 'short'
    }).format(new Date(unixSeconds * 1000));
  } catch {
    return null;
  }
}

function isoTime(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function resolveTournament(tournaments, tournamentId) {
  return tournamentId ? tournaments[tournamentId]?.name || null : null;
}

function resolveCategory(categories, categoryId) {
  return categoryId ? categories[categoryId]?.name || null : null;
}

function paramNumber(param, key) {
  const parts = String(param).split('|');

  for (const part of parts) {
    const [k, v] = part.split('=');
    if (k === key) {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }
  }

  return null;
}

function addCard(cards, card) {
  if (!card) return;

  const hasSelection = Array.isArray(card.selections) && card.selections.some(s => s.odd !== null);
  if (!hasSelection) return;

  cards.push(card);
}

function competitorNames(event) {
  const c = event?.desc?.competitors || [];
  return [
    c[0]?.name?.trim() || 'Competitor 1',
    c[1]?.name?.trim() || 'Competitor 2'
  ];
}

function winnerCard(event) {
  const [p1, p2] = competitorNames(event);
  const outcomes = event?.markets?.['186']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '186',
    key: 'winner',
    name: 'Winner',
    selections: [
      { label: p1, side: 1, outcome_id: '4', odd: toOdd(outcomes['4']) },
      { label: p2, side: 2, outcome_id: '5', odd: toOdd(outcomes['5']) }
    ]
  };
}

function setWinnerCards(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['202'];
  if (!market) return [];

  const cards = [];

  for (const setNr of [1, 2, 3]) {
    const outcomes = market[`setnr=${setNr}`];
    if (!outcomes) continue;

    cards.push({
      market_id: '202',
      key: `set_${setNr}_winner`,
      name: `${setNr === 1 ? 'First' : setNr === 2 ? 'Second' : 'Third'} set - winner`,
      set: setNr,
      selections: [
        { label: p1, side: 1, outcome_id: '4', odd: toOdd(outcomes['4']) },
        { label: p2, side: 2, outcome_id: '5', odd: toOdd(outcomes['5']) }
      ]
    });
  }

  return cards;
}

function totalGamesCard(event) {
  const market = event?.markets?.['189'];
  if (!market) return null;

  const selections = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const line = paramNumber(param, 'total');
    if (line === null) continue;

    selections.push({
      line,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  selections.sort((a, b) => a.line - b.line);

  return {
    market_id: '189',
    key: 'total_games',
    name: 'Total games',
    selections
  };
}

function playerTotalGamesCard(event, marketId, side) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.[marketId];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const line = paramNumber(param, 'total');
    if (line === null) continue;

    rows.push({
      line,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  rows.sort((a, b) => a.line - b.line);

  const player = side === 1 ? p1 : p2;

  return {
    market_id: marketId,
    key: `competitor_${side}_total_games`,
    name: `${player} total games`,
    competitor: side,
    competitor_name: player,
    selections: rows
  };
}

function gameHandicapCard(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['187'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const hcp1 = paramNumber(param, 'hcp');
    if (hcp1 === null) continue;

    rows.push({
      competitor_1: {
        label: p1,
        handicap: hcp1,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      competitor_2: {
        label: p2,
        handicap: -hcp1,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  rows.sort((a, b) => a.competitor_1.handicap - b.competitor_1.handicap);

  return {
    market_id: '187',
    key: 'game_handicap',
    name: 'Game handicap',
    selections: rows
  };
}

function setHandicapCard(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['188'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const hcp1 = paramNumber(param, 'hcp');
    if (hcp1 === null) continue;

    rows.push({
      competitor_1: {
        label: p1,
        handicap: hcp1,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      competitor_2: {
        label: p2,
        handicap: -hcp1,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  rows.sort((a, b) => a.competitor_1.handicap - b.competitor_1.handicap);

  return {
    market_id: '188',
    key: 'set_handicap',
    name: 'Set handicap',
    selections: rows
  };
}

function setGameHandicapCards(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['203'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const setNr = paramNumber(param, 'setnr');
    const hcp1 = paramNumber(param, 'hcp');
    if (setNr === null || hcp1 === null) continue;

    if (!grouped.has(setNr)) grouped.set(setNr, []);

    grouped.get(setNr).push({
      competitor_1: {
        label: p1,
        handicap: hcp1,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      competitor_2: {
        label: p2,
        handicap: -hcp1,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  const cards = [];

  for (const [setNr, rows] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => a.competitor_1.handicap - b.competitor_1.handicap);

    cards.push({
      market_id: '203',
      key: `set_${setNr}_game_handicap`,
      name: `${setNr === 1 ? 'First' : setNr === 2 ? 'Second' : 'Third'} set - game handicap`,
      set: setNr,
      selections: rows
    });
  }

  return cards;
}

function setTotalGamesCards(event) {
  const market = event?.markets?.['204'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const setNr = paramNumber(param, 'setnr');
    const line = paramNumber(param, 'total');
    if (setNr === null || line === null) continue;

    if (!grouped.has(setNr)) grouped.set(setNr, []);

    grouped.get(setNr).push({
      line,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  const cards = [];

  for (const [setNr, rows] of [...grouped.entries()].sort((a, b) => a[0] - b[0])) {
    rows.sort((a, b) => a.line - b.line);

    cards.push({
      market_id: '204',
      key: `set_${setNr}_total_games`,
      name: `${setNr === 1 ? 'First' : setNr === 2 ? 'Second' : 'Third'} set - total games`,
      set: setNr,
      selections: rows
    });
  }

  return cards;
}

function yesNoCard(event, marketId, key, name, param = '') {
  const outcomes = event?.markets?.[marketId]?.[param];
  if (!outcomes) return null;

  return {
    market_id: marketId,
    key,
    name,
    selections: [
      { label: 'Yes', outcome_id: '74', odd: toOdd(outcomes['74']) },
      { label: 'No', outcome_id: '76', odd: toOdd(outcomes['76']) }
    ]
  };
}

function totalSetsCard(event) {
  const market = event?.markets?.['314'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const line = paramNumber(param, 'total');
    if (line === null) continue;

    rows.push({
      line,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  return {
    market_id: '314',
    key: 'total_sets',
    name: 'Total sets',
    selections: rows
  };
}

function oddEvenCard(event, marketId, key, name, param = '') {
  const outcomes = event?.markets?.[marketId]?.[param];
  if (!outcomes) return null;

  return {
    market_id: marketId,
    key,
    name,
    selections: [
      { label: 'Odd', outcome_id: '70', odd: toOdd(outcomes['70']) },
      { label: 'Even', outcome_id: '72', odd: toOdd(outcomes['72']) }
    ]
  };
}

function correctScoreCard(event) {
  const [p1, p2] = competitorNames(event);
  const outcomes = event?.markets?.['45']?.[''];
  if (!outcomes) return null;

  const mapping = [
    ['278', `${p1} 2:0`, '2:0', 1],
    ['288', `${p1} 2:1`, '2:1', 1],
    ['294', `${p2} 0:2`, '0:2', 2],
    ['296', `${p2} 1:2`, '1:2', 2]
  ];

  return {
    market_id: '45',
    key: 'correct_score',
    name: 'Correct score',
    selections: mapping.map(([id, label, score, side]) => ({
      label,
      score,
      side,
      outcome_id: id,
      odd: toOdd(outcomes[id])
    }))
  };
}

function exactSetsCard(event) {
  const market = event?.markets?.['196'];
  if (!market) return null;

  const variant = Object.values(market)[0];
  if (!variant) return null;

  return {
    market_id: '196',
    key: 'exact_sets',
    name: 'Exact sets',
    selections: [
      {
        label: '2 sets',
        sets: 2,
        outcome_id: 'sr:exact_sets:bestof:3:32',
        odd: toOdd(variant['sr:exact_sets:bestof:3:32'])
      },
      {
        label: '3 sets',
        sets: 3,
        outcome_id: 'sr:exact_sets:bestof:3:33',
        odd: toOdd(variant['sr:exact_sets:bestof:3:33'])
      }
    ]
  };
}

function firstSetCorrectScoreCard(event) {
  const [p1, p2] = competitorNames(event);
  const outcomes = event?.markets?.['207']?.['setnr=1'];
  if (!outcomes) return null;

  const mapping = [
    ['865', `${p1} 6:0`, '6:0', 1],
    ['866', `${p1} 6:1`, '6:1', 1],
    ['867', `${p1} 6:2`, '6:2', 1],
    ['868', `${p1} 6:3`, '6:3', 1],
    ['869', `${p1} 6:4`, '6:4', 1],
    ['870', `${p1} 7:5`, '7:5', 1],
    ['871', `${p1} 7:6`, '7:6', 1],
    ['872', `${p2} 0:6`, '0:6', 2],
    ['873', `${p2} 1:6`, '1:6', 2],
    ['874', `${p2} 2:6`, '2:6', 2],
    ['875', `${p2} 3:6`, '3:6', 2],
    ['876', `${p2} 4:6`, '4:6', 2],
    ['877', `${p2} 5:7`, '5:7', 2],
    ['878', `${p2} 6:7`, '6:7', 2]
  ];

  return {
    market_id: '207',
    key: 'first_set_correct_score',
    name: 'First set - correct score',
    set: 1,
    selections: mapping.map(([id, label, score, side]) => ({
      label,
      score,
      side,
      outcome_id: id,
      odd: toOdd(outcomes[id])
    }))
  };
}

function winnerAndTotalCard(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['1055'];
  if (!market) return null;

  const selections = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const line = paramNumber(param, 'total');
    if (line === null) continue;

    selections.push(
      {
        label: `${p1} & over ${line}`,
        side: 1,
        total: line,
        total_side: 'over',
        outcome_id: '973',
        odd: toOdd(outcomes['973'])
      },
      {
        label: `${p1} & under ${line}`,
        side: 1,
        total: line,
        total_side: 'under',
        outcome_id: '975',
        odd: toOdd(outcomes['975'])
      },
      {
        label: `${p2} & over ${line}`,
        side: 2,
        total: line,
        total_side: 'over',
        outcome_id: '974',
        odd: toOdd(outcomes['974'])
      },
      {
        label: `${p2} & under ${line}`,
        side: 2,
        total: line,
        total_side: 'under',
        outcome_id: '976',
        odd: toOdd(outcomes['976'])
      }
    );
  }

  return {
    market_id: '1055',
    key: 'winner_and_total',
    name: 'Winner & total',
    selections
  };
}

function totalTiebreaksCard(event) {
  const market = event?.markets?.['13608'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const line = paramNumber(param, 'total');
    if (line === null) continue;

    rows.push({
      line,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  rows.sort((a, b) => a.line - b.line);

  return {
    market_id: '13608',
    key: 'total_tiebreaks',
    name: 'Total tiebreaks in the match',
    selections: rows
  };
}

function normalizeMarketCards(event) {
  const [p1, p2] = competitorNames(event);
  const cards = [];

  addCard(cards, winnerCard(event));

  for (const card of setWinnerCards(event)) addCard(cards, card);

  addCard(cards, totalGamesCard(event));
  addCard(cards, yesNoCard(
    event,
    '206',
    'first_set_tiebreak',
    'First set - will there be a tiebreak',
    'setnr=1'
  ));

  addCard(cards, yesNoCard(
    event,
    '192',
    'competitor_1_to_win_a_set',
    `${p1} to win a set`,
    ''
  ));

  addCard(cards, setHandicapCard(event));

  addCard(cards, yesNoCard(
    event,
    '193',
    'competitor_2_to_win_a_set',
    `${p2} to win a set`,
    ''
  ));

  addCard(cards, oddEvenCard(
    event,
    '205',
    'first_set_odd_even_games',
    'First set - odd/even games',
    'setnr=1'
  ));

  addCard(cards, correctScoreCard(event));
  addCard(cards, gameHandicapCard(event));

  addCard(cards, oddEvenCard(
    event,
    '198',
    'odd_even_games',
    'Odd/even games',
    ''
  ));

  addCard(cards, totalSetsCard(event));

  for (const card of setGameHandicapCards(event)) addCard(cards, card);

  addCard(cards, firstSetCorrectScoreCard(event));
  addCard(cards, playerTotalGamesCard(event, '190', 1));
  addCard(cards, winnerAndTotalCard(event));
  addCard(cards, totalTiebreaksCard(event));
  addCard(cards, exactSetsCard(event));
  addCard(cards, playerTotalGamesCard(event, '191', 2));

  for (const card of setTotalGamesCards(event)) addCard(cards, card);

  return cards;
}

function winnerSummary(event) {
  const card = winnerCard(event);
  if (!card) return null;

  const [a, b] = card.selections;
  if (!a?.odd || !b?.odd) return null;

  const p1 = 1 / a.odd;
  const p2 = 1 / b.odd;
  const total = p1 + p2;

  return {
    name: card.name,
    selections: [
      {
        competitor: 1,
        name: a.label,
        odd: a.odd,
        implied_probability_raw: Number((p1 * 100).toFixed(2)),
        implied_probability_no_vig: Number(((p1 / total) * 100).toFixed(2))
      },
      {
        competitor: 2,
        name: b.label,
        odd: b.odd,
        implied_probability_raw: Number((p2 * 100).toFixed(2)),
        implied_probability_no_vig: Number(((p2 / total) * 100).toFixed(2))
      }
    ],
    bookmaker_margin_percent: Number(((total - 1) * 100).toFixed(2))
  };
}

function normalizeEvent(eventId, event, categories, tournaments, eventUrl) {
  const desc = event?.desc;
  if (!desc || String(desc.sport) !== TENNIS_SPORT_ID) return null;
  if (desc.virtual === true) return null;
  if (!Array.isArray(desc.competitors) || desc.competitors.length < 2) return null;

  const now = Math.floor(Date.now() / 1000);

  if (desc.scheduled && desc.scheduled < now - 60) {
    return null;
  }

  if (HOURS_AHEAD > 0 && desc.scheduled) {
    const max = now + HOURS_AHEAD * 3600;
    if (desc.scheduled > max) return null;
  }

  const cards = normalizeMarketCards(event);

  const output = {
    event_id: eventId,
    sport: 'Tennis',
    virtual: false,
    category: resolveCategory(categories, desc.category),
    tournament: resolveTournament(tournaments, desc.tournament),
    scheduled_unix: desc.scheduled || null,
    scheduled_utc: isoTime(desc.scheduled),
    scheduled_brazil: brazilTime(desc.scheduled),
    competitor_1: {
      id: desc.competitors[0]?.id || null,
      name: desc.competitors[0]?.name?.trim() || null,
      country_code: desc.competitors[0]?.country_code || null
    },
    competitor_2: {
      id: desc.competitors[1]?.id || null,
      name: desc.competitors[1]?.name?.trim() || null,
      country_code: desc.competitors[1]?.country_code || null
    },
    market_card_count: cards.length,
    markets: {
      winner_summary: winnerSummary(event),
      cards
    },
    source_event_url: eventUrl
  };

  if (INCLUDE_RAW) {
    output.markets.raw = event.markets || {};
  }

  return output;
}


function parseParams(param) {
  const out = {};

  for (const part of String(param || '').split('|')) {
    if (!part) continue;
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index)] = part.slice(index + 1);
  }

  return out;
}

function numberParam(param, key) {
  const p = parseParams(param);
  const n = Number(p[key]);
  return Number.isFinite(n) ? n : null;
}

function cs2WinnerSummary(event) {
  const [p1, p2] = competitorNames(event);
  const outcomes = event?.markets?.['186']?.[''];

  if (!outcomes) return null;

  const odd1 = toOdd(outcomes['4']);
  const odd2 = toOdd(outcomes['5']);

  if (!odd1 || !odd2) return null;

  const raw1 = 1 / odd1;
  const raw2 = 1 / odd2;
  const total = raw1 + raw2;

  return {
    name: 'Winner',
    selections: [
      {
        competitor: 1,
        name: p1,
        odd: odd1,
        implied_probability_raw: Number((raw1 * 100).toFixed(2)),
        implied_probability_no_vig: Number(((raw1 / total) * 100).toFixed(2))
      },
      {
        competitor: 2,
        name: p2,
        odd: odd2,
        implied_probability_raw: Number((raw2 * 100).toFixed(2)),
        implied_probability_no_vig: Number(((raw2 / total) * 100).toFixed(2))
      }
    ],
    bookmaker_margin_percent: Number(((total - 1) * 100).toFixed(2))
  };
}

function cs2WinnerCard(event) {
  const [p1, p2] = competitorNames(event);
  const outcomes = event?.markets?.['186']?.[''];

  if (!outcomes) return null;

  return {
    market_id: '186',
    key: 'winner',
    name: 'Winner',
    selections: [
      { label: p1, side: 1, outcome_id: '4', odd: toOdd(outcomes['4']) },
      { label: p2, side: 2, outcome_id: '5', odd: toOdd(outcomes['5']) }
    ]
  };
}

function cs2MapHandicapCard(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['327'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const hcp1 = numberParam(param, 'hcp');
    if (hcp1 === null) continue;

    rows.push({
      competitor_1: {
        label: p1,
        handicap: hcp1,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      competitor_2: {
        label: p2,
        handicap: -hcp1,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  rows.sort((a, b) => a.competitor_1.handicap - b.competitor_1.handicap);

  return {
    market_id: '327',
    key: 'map_handicap',
    name: 'Map handicap',
    selections: rows
  };
}

function cs2TotalMapsCard(event) {
  const market = event?.markets?.['328'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const line = numberParam(param, 'total');
    if (line === null) continue;

    rows.push({
      line,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  rows.sort((a, b) => a.line - b.line);

  return {
    market_id: '328',
    key: 'total_maps',
    name: 'Total maps',
    selections: rows
  };
}

function cs2MapWinnerCards(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['330'];
  if (!market) return [];

  const cards = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const map = numberParam(param, 'mapnr');
    if (map === null) continue;

    cards.push({
      market_id: '330',
      key: `map_${map}_winner`,
      name: `Map ${map} - winner`,
      map,
      selections: [
        { label: p1, side: 1, outcome_id: '4', odd: toOdd(outcomes['4']) },
        { label: p2, side: 2, outcome_id: '5', odd: toOdd(outcomes['5']) }
      ]
    });
  }

  return cards.sort((a, b) => a.map - b.map);
}

function cs2RoundHandicapCards(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['331'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const map = numberParam(param, 'mapnr');
    const hcp1 = numberParam(param, 'hcp');

    if (map === null || hcp1 === null) continue;
    if (!grouped.has(map)) grouped.set(map, []);

    grouped.get(map).push({
      competitor_1: {
        label: p1,
        handicap: hcp1,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      competitor_2: {
        label: p2,
        handicap: -hcp1,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  const cards = [];

  for (const [map, rows] of grouped.entries()) {
    rows.sort((a, b) => a.competitor_1.handicap - b.competitor_1.handicap);

    cards.push({
      market_id: '331',
      key: `map_${map}_round_handicap`,
      name: `Map ${map} - round handicap`,
      map,
      selections: rows
    });
  }

  return cards.sort((a, b) => a.map - b.map);
}

function cs2TotalRoundsCards(event) {
  const market = event?.markets?.['332'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const map = numberParam(param, 'mapnr');
    const line = numberParam(param, 'total');

    if (map === null || line === null) continue;
    if (!grouped.has(map)) grouped.set(map, []);

    grouped.get(map).push({
      line,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  const cards = [];

  for (const [map, rows] of grouped.entries()) {
    rows.sort((a, b) => a.line - b.line);

    cards.push({
      market_id: '332',
      key: `map_${map}_total_rounds`,
      name: `Map ${map} - total rounds`,
      map,
      selections: rows
    });
  }

  return cards.sort((a, b) => a.map - b.map);
}

function cs2Map1x2Cards(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['334'];
  if (!market) return [];

  const cards = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const map = numberParam(param, 'mapnr');
    if (map === null) continue;

    cards.push({
      market_id: '334',
      key: `map_${map}_1x2_excl_overtime`,
      name: `Map ${map} - 1x2 (excl. overtime)`,
      map,
      selections: [
        { label: p1, result: '1', outcome_id: '1', odd: toOdd(outcomes['1']) },
        { label: 'Draw', result: 'draw', outcome_id: '2', odd: toOdd(outcomes['2']) },
        { label: p2, result: '2', outcome_id: '3', odd: toOdd(outcomes['3']) }
      ]
    });
  }

  return cards.sort((a, b) => a.map - b.map);
}

function cs2PistolRoundCards(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['50112'];
  if (!market) return [];

  const cards = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const p = parseParams(param);
    const map = Number(p.mapnr);
    const round = Number(p.roundnr);
    const order = Number(p.ordernr);

    if (!Number.isFinite(map) || !Number.isFinite(round) || !Number.isFinite(order)) continue;

    const pistol = order === 1 ? 1 : order === 2 ? 2 : order;

    cards.push({
      market_id: '50112',
      key: `map_${map}_pistol_${pistol}_winner`,
      name: `Map ${map} - ${pistol === 1 ? 'first' : pistol === 2 ? 'second' : pistol} pistol round winner`,
      map,
      pistol_round: pistol,
      round_number: round,
      selections: [
        { label: p1, side: 1, outcome_id: '1', odd: toOdd(outcomes['1']) },
        { label: p2, side: 2, outcome_id: '3', odd: toOdd(outcomes['3']) }
      ]
    });
  }

  return cards.sort((a, b) => (a.map - b.map) || (a.pistol_round - b.pistol_round));
}

function cs2WinnerAndTotalRoundsCards(event) {
  const [p1, p2] = competitorNames(event);
  const market = event?.markets?.['50339'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const map = numberParam(param, 'mapnr');
    const total = numberParam(param, 'total');

    if (map === null || total === null) continue;
    if (!grouped.has(map)) grouped.set(map, []);

    grouped.get(map).push(
      {
        label: `${p1} & under ${total}`,
        team: 1,
        total,
        total_side: 'under',
        outcome_id: 'od:combo:50339:1',
        odd: toOdd(outcomes['od:combo:50339:1'])
      },
      {
        label: `${p1} & over ${total}`,
        team: 1,
        total,
        total_side: 'over',
        outcome_id: 'od:combo:50339:2',
        odd: toOdd(outcomes['od:combo:50339:2'])
      },
      {
        label: `${p2} & under ${total}`,
        team: 2,
        total,
        total_side: 'under',
        outcome_id: 'od:combo:50339:3',
        odd: toOdd(outcomes['od:combo:50339:3'])
      },
      {
        label: `${p2} & over ${total}`,
        team: 2,
        total,
        total_side: 'over',
        outcome_id: 'od:combo:50339:4',
        odd: toOdd(outcomes['od:combo:50339:4'])
      }
    );
  }

  const cards = [];

  for (const [map, rows] of grouped.entries()) {
    rows.sort((a, b) => (a.total - b.total) || (a.team - b.team));

    cards.push({
      market_id: '50339',
      key: `map_${map}_winner_and_total_rounds`,
      name: `Map ${map} - winner & total rounds`,
      map,
      selections: rows
    });
  }

  return cards.sort((a, b) => a.map - b.map);
}

function cs2KnownCards(event) {
  const cards = [];

  const push = card => {
    if (!card) return;
    cards.push(card);
  };

  push(cs2WinnerCard(event));
  push(cs2MapHandicapCard(event));
  push(cs2TotalMapsCard(event));

  for (const card of cs2MapWinnerCards(event)) push(card);
  for (const card of cs2RoundHandicapCards(event)) push(card);
  for (const card of cs2TotalRoundsCards(event)) push(card);
  for (const card of cs2Map1x2Cards(event)) push(card);
  for (const card of cs2PistolRoundCards(event)) push(card);
  for (const card of cs2WinnerAndTotalRoundsCards(event)) push(card);

  return cards;
}

function normalizeCs2Event(eventId, event, categories, tournaments, eventUrl) {
  const desc = event?.desc;
  if (!desc || String(desc.sport) !== CS2_SPORT_ID) return null;
  if (desc.virtual === true) return null;
  if (!Array.isArray(desc.competitors) || desc.competitors.length < 2) return null;

  const now = Math.floor(Date.now() / 1000);

  if (desc.scheduled && desc.scheduled < now - 60) {
    return null;
  }

  if (HOURS_AHEAD > 0 && desc.scheduled) {
    const max = now + HOURS_AHEAD * 3600;
    if (desc.scheduled > max) return null;
  }

  const rawMarketIds = Object.keys(event.markets || {});
  const knownMarketIds = new Set([
    '186', '327', '328', '330', '331', '332', '334', '50112', '50339'
  ]);

  const knownCards = cs2KnownCards(event);
  const unmappedMarketIds = rawMarketIds.filter(id => !knownMarketIds.has(id));

  return {
    event_id: eventId,
    sport: 'Counter-Strike',
    sport_id: CS2_SPORT_ID,
    category: resolveCategory(categories, desc.category),
    tournament: resolveTournament(tournaments, desc.tournament),
    virtual: false,
    scheduled_unix: desc.scheduled || null,
    scheduled_utc: isoTime(desc.scheduled),
    scheduled_brazil: brazilTime(desc.scheduled),
    competitor_1: {
      id: desc.competitors[0]?.id || null,
      name: desc.competitors[0]?.name?.trim() || null,
      country_code: desc.competitors[0]?.country_code || null
    },
    competitor_2: {
      id: desc.competitors[1]?.id || null,
      name: desc.competitors[1]?.name?.trim() || null,
      country_code: desc.competitors[1]?.country_code || null
    },
    raw_market_count: rawMarketIds.length,
    raw_market_ids: rawMarketIds,
    known_market_card_count: knownCards.length,
    unmapped_market_count: unmappedMarketIds.length,
    unmapped_market_ids: unmappedMarketIds,
    markets: {
      winner_summary: cs2WinnerSummary(event),
      cards: knownCards,
      raw: event.markets || {}
    },
    source_event_url: eventUrl
  };
}


function footballThreeWaySummary(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['1']?.[''];
  if (!outcomes) return null;

  const oddHome = toOdd(outcomes['1']);
  const oddDraw = toOdd(outcomes['2']);
  const oddAway = toOdd(outcomes['3']);

  if (!oddHome || !oddDraw || !oddAway) return null;

  const pHome = 1 / oddHome;
  const pDraw = 1 / oddDraw;
  const pAway = 1 / oddAway;
  const total = pHome + pDraw + pAway;

  return {
    name: '1x2',
    selections: [
      {
        result: '1',
        name: home,
        odd: oddHome,
        implied_probability_raw: Number((pHome * 100).toFixed(2)),
        implied_probability_no_vig: Number(((pHome / total) * 100).toFixed(2))
      },
      {
        result: 'draw',
        name: 'Draw',
        odd: oddDraw,
        implied_probability_raw: Number((pDraw * 100).toFixed(2)),
        implied_probability_no_vig: Number(((pDraw / total) * 100).toFixed(2))
      },
      {
        result: '2',
        name: away,
        odd: oddAway,
        implied_probability_raw: Number((pAway * 100).toFixed(2)),
        implied_probability_no_vig: Number(((pAway / total) * 100).toFixed(2))
      }
    ],
    bookmaker_margin_percent: Number(((total - 1) * 100).toFixed(2))
  };
}

function football1x2Card(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['1']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '1',
    key: 'match_1x2',
    name: '1x2',
    selections: [
      { label: home, result: '1', outcome_id: '1', odd: toOdd(outcomes['1']) },
      { label: 'Draw', result: 'draw', outcome_id: '2', odd: toOdd(outcomes['2']) },
      { label: away, result: '2', outcome_id: '3', odd: toOdd(outcomes['3']) }
    ]
  };
}

function footballDoubleChanceCard(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['10']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '10',
    key: 'double_chance',
    name: 'Double chance',
    selections: [
      { label: `${home} or draw`, result: '1X', outcome_id: '9', odd: toOdd(outcomes['9']) },
      { label: `${home} or ${away}`, result: '12', outcome_id: '10', odd: toOdd(outcomes['10']) },
      { label: `Draw or ${away}`, result: 'X2', outcome_id: '11', odd: toOdd(outcomes['11']) }
    ]
  };
}

function footballFirstGoalCard(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['8']?.['goalnr=1'];
  if (!outcomes) return null;

  return {
    market_id: '8',
    key: 'first_goal',
    name: 'Goal - first team to score',
    selections: [
      { label: home, result: 'home', outcome_id: '6', odd: toOdd(outcomes['6']) },
      { label: 'None', result: 'none', outcome_id: '7', odd: toOdd(outcomes['7']) },
      { label: away, result: 'away', outcome_id: '8', odd: toOdd(outcomes['8']) }
    ]
  };
}

function footballTotalCard(event, marketId, key, name) {
  const market = event?.markets?.[marketId];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const total = numberParam(param, 'total');
    if (total === null) continue;

    rows.push({
      line: total,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  rows.sort((a, b) => a.line - b.line);

  return {
    market_id: marketId,
    key,
    name,
    selections: rows
  };
}

function footballTeamTotalCard(event, marketId, side) {
  const [home, away] = competitorNames(event);
  const team = side === 1 ? home : away;
  const card = footballTotalCard(
    event,
    marketId,
    side === 1 ? 'home_team_total' : 'away_team_total',
    `${team} total`
  );

  if (!card) return null;
  card.team = side;
  card.team_name = team;
  return card;
}

function footballBttsCard(event) {
  const outcomes = event?.markets?.['29']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '29',
    key: 'both_teams_to_score',
    name: 'Both teams to score',
    selections: [
      { label: 'Yes', outcome_id: '74', odd: toOdd(outcomes['74']) },
      { label: 'No', outcome_id: '76', odd: toOdd(outcomes['76']) }
    ]
  };
}

function footballDrawNoBetCard(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['11']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '11',
    key: 'draw_no_bet',
    name: 'Draw no bet',
    selections: [
      { label: home, side: 1, outcome_id: '4', odd: toOdd(outcomes['4']) },
      { label: away, side: 2, outcome_id: '5', odd: toOdd(outcomes['5']) }
    ]
  };
}

function footballHandicapCard(event) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.['16'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const hcpHome = numberParam(param, 'hcp');
    if (hcpHome === null) continue;

    rows.push({
      home: {
        label: home,
        handicap: hcpHome,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      away: {
        label: away,
        handicap: -hcpHome,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  rows.sort((a, b) => a.home.handicap - b.home.handicap);

  return {
    market_id: '16',
    key: 'handicap',
    name: 'Handicap / Asian handicap',
    selections: rows
  };
}

function football1x2AndTotalCard(event) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.['37'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const total = numberParam(param, 'total');
    if (total === null) continue;

    rows.push({
      total,
      selections: [
        { label: `${home} & under ${total}`, result: '1', total_side: 'under', outcome_id: '794', odd: toOdd(outcomes['794']) },
        { label: `${home} & over ${total}`, result: '1', total_side: 'over', outcome_id: '796', odd: toOdd(outcomes['796']) },
        { label: `Draw & under ${total}`, result: 'draw', total_side: 'under', outcome_id: '798', odd: toOdd(outcomes['798']) },
        { label: `Draw & over ${total}`, result: 'draw', total_side: 'over', outcome_id: '800', odd: toOdd(outcomes['800']) },
        { label: `${away} & under ${total}`, result: '2', total_side: 'under', outcome_id: '802', odd: toOdd(outcomes['802']) },
        { label: `${away} & over ${total}`, result: '2', total_side: 'over', outcome_id: '804', odd: toOdd(outcomes['804']) }
      ]
    });
  }

  rows.sort((a, b) => a.total - b.total);

  return {
    market_id: '37',
    key: 'match_1x2_and_total',
    name: '1x2 & total',
    selections: rows
  };
}

function football1x2AndBttsCard(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['35']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '35',
    key: 'match_1x2_and_btts',
    name: '1x2 & both teams to score',
    selections: [
      { label: `${home} & yes`, result: '1', btts: 'yes', outcome_id: '78', odd: toOdd(outcomes['78']) },
      { label: `${home} & no`, result: '1', btts: 'no', outcome_id: '80', odd: toOdd(outcomes['80']) },
      { label: 'Draw & yes', result: 'draw', btts: 'yes', outcome_id: '82', odd: toOdd(outcomes['82']) },
      { label: 'Draw & no', result: 'draw', btts: 'no', outcome_id: '84', odd: toOdd(outcomes['84']) },
      { label: `${away} & yes`, result: '2', btts: 'yes', outcome_id: '86', odd: toOdd(outcomes['86']) },
      { label: `${away} & no`, result: '2', btts: 'no', outcome_id: '88', odd: toOdd(outcomes['88']) }
    ]
  };
}

function footballTotalAndBttsCard(event) {
  const market = event?.markets?.['36'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const total = numberParam(param, 'total');
    if (total === null) continue;

    rows.push({
      total,
      selections: [
        { label: `Over ${total} & yes`, total_side: 'over', btts: 'yes', outcome_id: '90', odd: toOdd(outcomes['90']) },
        { label: `Under ${total} & yes`, total_side: 'under', btts: 'yes', outcome_id: '92', odd: toOdd(outcomes['92']) },
        { label: `Over ${total} & no`, total_side: 'over', btts: 'no', outcome_id: '94', odd: toOdd(outcomes['94']) },
        { label: `Under ${total} & no`, total_side: 'under', btts: 'no', outcome_id: '96', odd: toOdd(outcomes['96']) }
      ]
    });
  }

  rows.sort((a, b) => a.total - b.total);

  return {
    market_id: '36',
    key: 'total_and_btts',
    name: 'Total & both teams to score',
    selections: rows
  };
}

function footballCorner1x2Card(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['162']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '162',
    key: 'corner_1x2',
    name: 'Corner 1x2',
    selections: [
      { label: home, result: '1', outcome_id: '1', odd: toOdd(outcomes['1']) },
      { label: 'Draw', result: 'draw', outcome_id: '2', odd: toOdd(outcomes['2']) },
      { label: away, result: '2', outcome_id: '3', odd: toOdd(outcomes['3']) }
    ]
  };
}

function footballFirstHalf1x2Card(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['60']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '60',
    key: 'first_half_1x2',
    name: '1st half - 1x2',
    selections: [
      { label: home, result: '1', outcome_id: '1', odd: toOdd(outcomes['1']) },
      { label: 'Draw', result: 'draw', outcome_id: '2', odd: toOdd(outcomes['2']) },
      { label: away, result: '2', outcome_id: '3', odd: toOdd(outcomes['3']) }
    ]
  };
}

function footballYesNoCard(event, marketId, key, name) {
  const outcomes = event?.markets?.[marketId]?.[''];
  if (!outcomes) return null;

  return {
    market_id: marketId,
    key,
    name,
    selections: [
      { label: 'Yes', outcome_id: '74', odd: toOdd(outcomes['74']) },
      { label: 'No', outcome_id: '76', odd: toOdd(outcomes['76']) }
    ]
  };
}

function footballKnownCards(event) {
  const cards = [];
  const push = card => {
    if (card) cards.push(card);
  };

  push(football1x2Card(event));
  push(footballDoubleChanceCard(event));
  push(footballFirstGoalCard(event));
  push(footballTotalCard(event, '18', 'total_goals', 'Total'));
  push(footballTeamTotalCard(event, '19', 1));
  push(footballTeamTotalCard(event, '20', 2));
  push(footballBttsCard(event));
  push(footballDrawNoBetCard(event));
  push(footballHandicapCard(event));
  push(football1x2AndTotalCard(event));
  push(football1x2AndBttsCard(event));
  push(footballTotalAndBttsCard(event));
  push(footballTotalCard(event, '166', 'total_corners', 'Total corners'));
  push(footballCorner1x2Card(event));
  push(footballFirstHalf1x2Card(event));
  push(footballTotalCard(event, '68', 'first_half_total', '1st half - total'));
  push(footballTotalCard(event, '177', 'first_half_total_corners', '1st half - total corners'));
  push(footballYesNoCard(event, '50305', 'will_be_a_penalty', 'Will be a penalty'));
  push(footballYesNoCard(event, '562', 'btts_both_halves', 'Both teams to score in both halves'));

  return cards;
}

function normalizeFootballEvent(eventId, event, categories, tournaments, eventUrl) {
  const desc = event?.desc;
  if (!desc || String(desc.sport) !== FOOTBALL_SPORT_ID) return null;
  if (desc.virtual === true) return null;
  if (!Array.isArray(desc.competitors) || desc.competitors.length < 2) return null;

  const now = Math.floor(Date.now() / 1000);

  if (desc.scheduled && desc.scheduled < now - 60) return null;

  if (HOURS_AHEAD > 0 && desc.scheduled) {
    const max = now + HOURS_AHEAD * 3600;
    if (desc.scheduled > max) return null;
  }

  const rawMarketIds = Object.keys(event.markets || {});
  const normalizedMarketIds = new Set([
    '1', '8', '10', '11', '16', '18', '19', '20', '29', '35',
    '36', '37', '60', '68', '162', '166', '177', '562', '50305'
  ]);

  const knownCards = footballKnownCards(event);
  const unmappedMarketIds = rawMarketIds.filter(id => !normalizedMarketIds.has(id));

  const markets = {
    winner_summary: footballThreeWaySummary(event),
    cards: knownCards
  };

  if (INCLUDE_RAW) {
    markets.raw = event.markets || {};
  }

  return {
    event_id: eventId,
    sport: 'Soccer',
    sport_id: FOOTBALL_SPORT_ID,
    category: resolveCategory(categories, desc.category),
    tournament: resolveTournament(tournaments, desc.tournament),
    virtual: false,
    scheduled_unix: desc.scheduled || null,
    scheduled_utc: isoTime(desc.scheduled),
    scheduled_brazil: brazilTime(desc.scheduled),
    competitor_1: {
      id: desc.competitors[0]?.id || null,
      name: desc.competitors[0]?.name?.trim() || null,
      country_code: desc.competitors[0]?.country_code || null
    },
    competitor_2: {
      id: desc.competitors[1]?.id || null,
      name: desc.competitors[1]?.name?.trim() || null,
      country_code: desc.competitors[1]?.country_code || null
    },
    player_props: desc.player_props === true,
    bet_builder: desc.bet_builder === true,
    raw_market_count: rawMarketIds.length,
    raw_market_ids: rawMarketIds,
    known_market_card_count: knownCards.length,
    unmapped_market_count: unmappedMarketIds.length,
    unmapped_market_ids: unmappedMarketIds,
    markets,
    source_event_url: eventUrl
  };
}


function quarterName(n) {
  return n === 1 ? 'First quarter'
    : n === 2 ? 'Second quarter'
    : n === 3 ? 'Third quarter'
    : n === 4 ? 'Fourth quarter'
    : `Quarter ${n}`;
}

function basketballWinnerSummary(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['219']?.[''];
  if (!outcomes) return null;

  const oddHome = toOdd(outcomes['4']);
  const oddAway = toOdd(outcomes['5']);
  if (!oddHome || !oddAway) return null;

  const pHome = 1 / oddHome;
  const pAway = 1 / oddAway;
  const total = pHome + pAway;

  return {
    name: 'Winner (incl. overtime)',
    selections: [
      {
        competitor: 1,
        name: home,
        odd: oddHome,
        implied_probability_raw: Number((pHome * 100).toFixed(2)),
        implied_probability_no_vig: Number(((pHome / total) * 100).toFixed(2))
      },
      {
        competitor: 2,
        name: away,
        odd: oddAway,
        implied_probability_raw: Number((pAway * 100).toFixed(2)),
        implied_probability_no_vig: Number(((pAway / total) * 100).toFixed(2))
      }
    ],
    bookmaker_margin_percent: Number(((total - 1) * 100).toFixed(2))
  };
}

function basketballWinnerCard(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['219']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '219',
    key: 'winner_including_overtime',
    name: 'Winner (incl. overtime)',
    selections: [
      { label: home, side: 1, outcome_id: '4', odd: toOdd(outcomes['4']) },
      { label: away, side: 2, outcome_id: '5', odd: toOdd(outcomes['5']) }
    ]
  };
}

function basketball1x2Card(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['1']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '1',
    key: 'match_1x2',
    name: '1x2',
    selections: [
      { label: home, result: '1', outcome_id: '1', odd: toOdd(outcomes['1']) },
      { label: 'Draw', result: 'draw', outcome_id: '2', odd: toOdd(outcomes['2']) },
      { label: away, result: '2', outcome_id: '3', odd: toOdd(outcomes['3']) }
    ]
  };
}

function basketballDoubleChanceCard(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['10']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '10',
    key: 'double_chance',
    name: 'Double chance',
    selections: [
      { label: `${home} or draw`, result: '1X', outcome_id: '9', odd: toOdd(outcomes['9']) },
      { label: `${home} or ${away}`, result: '12', outcome_id: '10', odd: toOdd(outcomes['10']) },
      { label: `Draw or ${away}`, result: 'X2', outcome_id: '11', odd: toOdd(outcomes['11']) }
    ]
  };
}

function basketballTotalCard(event, marketId, key, name) {
  const market = event?.markets?.[marketId];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const total = numberParam(param, 'total');
    if (total === null) continue;

    rows.push({
      line: total,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  rows.sort((a, b) => a.line - b.line);

  return {
    market_id: marketId,
    key,
    name,
    selections: rows
  };
}

function basketballHandicapCard(event, marketId, key, name) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.[marketId];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const hcp = numberParam(param, 'hcp');
    if (hcp === null) continue;

    rows.push({
      home: {
        label: home,
        handicap: hcp,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      away: {
        label: away,
        handicap: -hcp,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  rows.sort((a, b) => a.home.handicap - b.home.handicap);

  return {
    market_id: marketId,
    key,
    name,
    selections: rows
  };
}

function basketballQuarter1x2Cards(event) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.['235'];
  if (!market) return [];

  const cards = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const q = numberParam(param, 'quarternr');
    if (q === null) continue;

    cards.push({
      market_id: '235',
      key: `quarter_${q}_1x2`,
      name: `${quarterName(q)} - 1x2`,
      quarter: q,
      selections: [
        { label: home, result: '1', outcome_id: '1', odd: toOdd(outcomes['1']) },
        { label: 'Draw', result: 'draw', outcome_id: '2', odd: toOdd(outcomes['2']) },
        { label: away, result: '2', outcome_id: '3', odd: toOdd(outcomes['3']) }
      ]
    });
  }

  return cards.sort((a, b) => a.quarter - b.quarter);
}

function basketballQuarterTotalCards(event) {
  const market = event?.markets?.['236'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const q = numberParam(param, 'quarternr');
    const total = numberParam(param, 'total');
    if (q === null || total === null) continue;

    if (!grouped.has(q)) grouped.set(q, []);
    grouped.get(q).push({
      line: total,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([q, rows]) => ({
      market_id: '236',
      key: `quarter_${q}_total`,
      name: `${quarterName(q)} - total`,
      quarter: q,
      selections: rows.sort((a, b) => a.line - b.line)
    }));
}

function basketballQuarterHandicapCards(event) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.['303'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const q = numberParam(param, 'quarternr');
    const hcp = numberParam(param, 'hcp');
    if (q === null || hcp === null) continue;

    if (!grouped.has(q)) grouped.set(q, []);
    grouped.get(q).push({
      home: {
        label: home,
        handicap: hcp,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      away: {
        label: away,
        handicap: -hcp,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([q, rows]) => ({
      market_id: '303',
      key: `quarter_${q}_handicap`,
      name: `${quarterName(q)} - handicap`,
      quarter: q,
      selections: rows.sort((a, b) => a.home.handicap - b.home.handicap)
    }));
}

function basketballQuarterTeamTotalCards(event, marketId, side) {
  const [home, away] = competitorNames(event);
  const team = side === 1 ? home : away;
  const market = event?.markets?.[marketId];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const q = numberParam(param, 'quarternr');
    const total = numberParam(param, 'total');
    if (q === null || total === null) continue;

    if (!grouped.has(q)) grouped.set(q, []);
    grouped.get(q).push({
      line: total,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([q, rows]) => ({
      market_id: marketId,
      key: `quarter_${q}_team_${side}_total`,
      name: `${quarterName(q)} - ${team} total`,
      quarter: q,
      team: side,
      team_name: team,
      selections: rows.sort((a, b) => a.line - b.line)
    }));
}

function basketballQuarterOddEvenCards(event) {
  const market = event?.markets?.['304'];
  if (!market) return [];

  const cards = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const q = numberParam(param, 'quarternr');
    if (q === null) continue;

    cards.push({
      market_id: '304',
      key: `quarter_${q}_odd_even`,
      name: `${quarterName(q)} - odd/even`,
      quarter: q,
      selections: [
        { label: 'Odd', outcome_id: '70', odd: toOdd(outcomes['70']) },
        { label: 'Even', outcome_id: '72', odd: toOdd(outcomes['72']) }
      ]
    });
  }

  return cards.sort((a, b) => a.quarter - b.quarter);
}

function basketballHalfOddEvenCard(event) {
  const outcomes = event?.markets?.['74']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '74',
    key: 'first_half_odd_even',
    name: '1st half - odd/even',
    selections: [
      { label: 'Odd', outcome_id: '70', odd: toOdd(outcomes['70']) },
      { label: 'Even', outcome_id: '72', odd: toOdd(outcomes['72']) }
    ]
  };
}

function basketballMatchOddEvenCard(event) {
  const outcomes = event?.markets?.['229']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '229',
    key: 'odd_even_including_overtime',
    name: 'Odd/even (incl. overtime)',
    selections: [
      { label: 'Odd', outcome_id: '70', odd: toOdd(outcomes['70']) },
      { label: 'Even', outcome_id: '72', odd: toOdd(outcomes['72']) }
    ]
  };
}

function basketballOvertimeCard(event) {
  const outcomes = event?.markets?.['220']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '220',
    key: 'will_there_be_overtime',
    name: 'Will there be overtime',
    selections: [
      { label: 'Yes', outcome_id: '74', odd: toOdd(outcomes['74']) },
      { label: 'No', outcome_id: '76', odd: toOdd(outcomes['76']) }
    ]
  };
}

function basketballRaceToPointsCards(event) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.['50010'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const q = numberParam(param, 'quarternr');
    const points = numberParam(param, 'pointnr');
    if (q === null || points === null) continue;

    if (!grouped.has(q)) grouped.set(q, []);
    grouped.get(q).push({
      points,
      home: { label: home, outcome_id: '6', odd: toOdd(outcomes['6']) },
      none: { label: 'None', outcome_id: '7', odd: toOdd(outcomes['7']) },
      away: { label: away, outcome_id: '8', odd: toOdd(outcomes['8']) }
    });
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([q, rows]) => ({
      market_id: '50010',
      key: `quarter_${q}_race_to_points_3way`,
      name: `${quarterName(q)} - race to points (3 way)`,
      quarter: q,
      selections: rows.sort((a, b) => a.points - b.points)
    }));
}

function basketballWinnerAndTotalCard(event, marketId, key, name, outcomeMap) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.[marketId];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const total = numberParam(param, 'total');
    if (total === null) continue;

    rows.push({
      total,
      selections: [
        {
          label: `${home} & under ${total}`,
          side: 1,
          total_side: 'under',
          outcome_id: outcomeMap.home_under,
          odd: toOdd(outcomes[outcomeMap.home_under])
        },
        {
          label: `${home} & over ${total}`,
          side: 1,
          total_side: 'over',
          outcome_id: outcomeMap.home_over,
          odd: toOdd(outcomes[outcomeMap.home_over])
        },
        {
          label: `${away} & under ${total}`,
          side: 2,
          total_side: 'under',
          outcome_id: outcomeMap.away_under,
          odd: toOdd(outcomes[outcomeMap.away_under])
        },
        {
          label: `${away} & over ${total}`,
          side: 2,
          total_side: 'over',
          outcome_id: outcomeMap.away_over,
          odd: toOdd(outcomes[outcomeMap.away_over])
        }
      ]
    });
  }

  rows.sort((a, b) => a.total - b.total);

  return {
    market_id: marketId,
    key,
    name,
    selections: rows
  };
}

function basketballKnownCards(event) {
  const cards = [];
  const push = card => {
    if (card) cards.push(card);
  };

  push(basketballWinnerCard(event));
  push(basketball1x2Card(event));
  push(basketballDoubleChanceCard(event));
  push(basketballHandicapCard(event, '223', 'handicap_including_overtime', 'Handicap (incl. overtime)'));
  push(basketballTotalCard(event, '225', 'total_including_overtime', 'Total (incl. overtime)'));
  push(basketballTotalCard(event, '227', 'home_total_including_overtime', `${competitorNames(event)[0]} total (incl. overtime)`));
  push(basketballTotalCard(event, '228', 'away_total_including_overtime', `${competitorNames(event)[1]} total (incl. overtime)`));

  for (const card of basketballQuarter1x2Cards(event)) push(card);
  for (const card of basketballQuarterTotalCards(event)) push(card);
  for (const card of basketballQuarterHandicapCards(event)) push(card);
  for (const card of basketballQuarterTeamTotalCards(event, '756', 1)) push(card);
  for (const card of basketballQuarterTeamTotalCards(event, '757', 2)) push(card);
  for (const card of basketballQuarterOddEvenCards(event)) push(card);
  for (const card of basketballRaceToPointsCards(event)) push(card);

  push(footballFirstHalf1x2Card(event));
  push(basketballHandicapCard(event, '66', 'first_half_handicap', '1st half - handicap'));
  push(basketballTotalCard(event, '68', 'first_half_total', '1st half - total'));
  push(basketballTotalCard(event, '69', 'first_half_home_total', `1st half - ${competitorNames(event)[0]} total`));
  push(basketballTotalCard(event, '70', 'first_half_away_total', `1st half - ${competitorNames(event)[1]} total`));
  push(basketballHalfOddEvenCard(event));

  push(basketballWinnerAndTotalCard(
    event,
    '1177',
    'first_half_winner_and_total',
    '1st half - winner & total',
    { home_under: '794', home_over: '796', away_under: '802', away_over: '804' }
  ));

  push(basketballWinnerAndTotalCard(
    event,
    '1175',
    'first_quarter_winner_and_total',
    '1st quarter - winner & total',
    { home_under: '794', home_over: '796', away_under: '802', away_over: '804' }
  ));

  push(basketballMatchOddEvenCard(event));
  push(basketballWinnerAndTotalCard(
    event,
    '292',
    'winner_and_total_including_overtime',
    'Winner & total (incl. overtime)',
    { home_under: '975', home_over: '973', away_under: '976', away_over: '974' }
  ));
  push(basketballOvertimeCard(event));

  return cards;
}

function normalizeBasketballEvent(eventId, event, categories, tournaments, eventUrl) {
  const desc = event?.desc;
  if (!desc || String(desc.sport) !== BASKETBALL_SPORT_ID) return null;
  if (desc.virtual === true) return null;
  if (!Array.isArray(desc.competitors) || desc.competitors.length < 2) return null;

  const now = Math.floor(Date.now() / 1000);

  if (desc.scheduled && desc.scheduled < now - 60) return null;

  if (HOURS_AHEAD > 0 && desc.scheduled) {
    const max = now + HOURS_AHEAD * 3600;
    if (desc.scheduled > max) return null;
  }

  const rawMarketIds = Object.keys(event.markets || {});
  const normalizedMarketIds = new Set([
    '1', '10', '60', '66', '68', '69', '70', '74',
    '219', '220', '223', '225', '227', '228', '229',
    '235', '236', '292', '303', '304', '756', '757',
    '1175', '1177', '50010'
  ]);
  const recognizedPlayerPropIds = new Set([
    '768', '770', '772', '774',
    '921', '922', '923', '924',
    '50212', '50213', '50266', '50267', '50268',
    '50286', '50287', '50288'
  ]);

  const knownCards = basketballKnownCards(event);
  const playerPropMarketIds = rawMarketIds.filter(id => recognizedPlayerPropIds.has(id));
  const unmappedMarketIds = rawMarketIds.filter(
    id => !normalizedMarketIds.has(id) && !recognizedPlayerPropIds.has(id)
  );

  const markets = {
    winner_summary: basketballWinnerSummary(event),
    cards: knownCards
  };

  if (INCLUDE_RAW) {
    markets.raw = event.markets || {};
  }

  return {
    event_id: eventId,
    sport: 'Basketball',
    sport_id: BASKETBALL_SPORT_ID,
    category: resolveCategory(categories, desc.category),
    tournament: resolveTournament(tournaments, desc.tournament),
    virtual: false,
    scheduled_unix: desc.scheduled || null,
    scheduled_utc: isoTime(desc.scheduled),
    scheduled_brazil: brazilTime(desc.scheduled),
    competitor_1: {
      id: desc.competitors[0]?.id || null,
      name: desc.competitors[0]?.name?.trim() || null,
      country_code: desc.competitors[0]?.country_code || null
    },
    competitor_2: {
      id: desc.competitors[1]?.id || null,
      name: desc.competitors[1]?.name?.trim() || null,
      country_code: desc.competitors[1]?.country_code || null
    },
    player_props: desc.player_props === true,
    bet_builder: desc.bet_builder === true,
    raw_market_count: rawMarketIds.length,
    raw_market_ids: rawMarketIds,
    known_market_card_count: knownCards.length,
    recognized_player_prop_market_count: playerPropMarketIds.length,
    recognized_player_prop_market_ids: playerPropMarketIds,
    player_prop_names_resolved: false,
    unmapped_market_count: unmappedMarketIds.length,
    unmapped_market_ids: unmappedMarketIds,
    markets,
    source_event_url: eventUrl
  };
}


function baseballWinnerSummary(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['251']?.[''];
  if (!outcomes) return null;

  const oddHome = toOdd(outcomes['4']);
  const oddAway = toOdd(outcomes['5']);
  if (!oddHome || !oddAway) return null;

  const pHome = 1 / oddHome;
  const pAway = 1 / oddAway;
  const total = pHome + pAway;

  return {
    name: 'Winner (incl. extra innings)',
    selections: [
      {
        competitor: 1,
        name: home,
        odd: oddHome,
        implied_probability_raw: Number((pHome * 100).toFixed(2)),
        implied_probability_no_vig: Number(((pHome / total) * 100).toFixed(2))
      },
      {
        competitor: 2,
        name: away,
        odd: oddAway,
        implied_probability_raw: Number((pAway * 100).toFixed(2)),
        implied_probability_no_vig: Number(((pAway / total) * 100).toFixed(2))
      }
    ],
    bookmaker_margin_percent: Number(((total - 1) * 100).toFixed(2))
  };
}

function baseballWinnerCard(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['251']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '251',
    key: 'winner_including_extra_innings',
    name: 'Winner (incl. extra innings)',
    selections: [
      { label: home, side: 1, outcome_id: '4', odd: toOdd(outcomes['4']) },
      { label: away, side: 2, outcome_id: '5', odd: toOdd(outcomes['5']) }
    ]
  };
}

function baseballTotalCard(event, marketId, key, name) {
  const market = event?.markets?.[marketId];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const total = numberParam(param, 'total');
    if (total === null) continue;

    rows.push({
      line: total,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  rows.sort((a, b) => a.line - b.line);

  return {
    market_id: marketId,
    key,
    name,
    selections: rows
  };
}

function baseballHandicapCard(event) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.['256'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const hcp = numberParam(param, 'hcp');
    if (hcp === null) continue;

    rows.push({
      home: {
        label: home,
        handicap: hcp,
        outcome_id: '1714',
        odd: toOdd(outcomes['1714'])
      },
      away: {
        label: away,
        handicap: -hcp,
        outcome_id: '1715',
        odd: toOdd(outcomes['1715'])
      }
    });
  }

  rows.sort((a, b) => a.home.handicap - b.home.handicap);

  return {
    market_id: '256',
    key: 'handicap_including_extra_innings',
    name: 'Handicap (incl. extra innings)',
    selections: rows
  };
}

function baseballOddEvenCard(event) {
  const outcomes = event?.markets?.['264']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '264',
    key: 'odd_even_including_extra_innings',
    name: 'Odd/even (incl. extra innings)',
    selections: [
      { label: 'Odd', outcome_id: '70', odd: toOdd(outcomes['70']) },
      { label: 'Even', outcome_id: '72', odd: toOdd(outcomes['72']) }
    ]
  };
}

function baseballExtraInningCard(event) {
  const outcomes = event?.markets?.['268']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '268',
    key: 'will_there_be_extra_inning',
    name: 'Will there be an extra inning',
    selections: [
      { label: 'Yes', outcome_id: '74', odd: toOdd(outcomes['74']) },
      { label: 'No', outcome_id: '76', odd: toOdd(outcomes['76']) }
    ]
  };
}

function baseballFiveInnings1x2Card(event) {
  const [home, away] = competitorNames(event);
  const outcomes = event?.markets?.['274']?.[''];
  if (!outcomes) return null;

  return {
    market_id: '274',
    key: 'innings_1_to_5_1x2',
    name: 'Innings 1 to 5 - 1x2',
    selections: [
      { label: home, result: '1', outcome_id: '1', odd: toOdd(outcomes['1']) },
      { label: 'Draw', result: 'draw', outcome_id: '2', odd: toOdd(outcomes['2']) },
      { label: away, result: '2', outcome_id: '3', odd: toOdd(outcomes['3']) }
    ]
  };
}

function baseballInning1x2Cards(event) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.['287'];
  if (!market) return [];

  const cards = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const inning = numberParam(param, 'inningnr');
    if (inning === null) continue;

    cards.push({
      market_id: '287',
      key: `inning_${inning}_1x2`,
      name: `${inning === 1 ? 'First' : inning === 2 ? 'Second' : `${inning}th`} inning - 1x2`,
      inning,
      selections: [
        { label: home, result: '1', outcome_id: '1', odd: toOdd(outcomes['1']) },
        { label: 'Draw', result: 'draw', outcome_id: '2', odd: toOdd(outcomes['2']) },
        { label: away, result: '2', outcome_id: '3', odd: toOdd(outcomes['3']) }
      ]
    });
  }

  return cards.sort((a, b) => a.inning - b.inning);
}

function baseballInningTotalCards(event) {
  const market = event?.markets?.['288'];
  if (!market) return [];

  const grouped = new Map();

  for (const [param, outcomes] of Object.entries(market)) {
    const inning = numberParam(param, 'inningnr');
    const total = numberParam(param, 'total');
    if (inning === null || total === null) continue;

    if (!grouped.has(inning)) grouped.set(inning, []);
    grouped.get(inning).push({
      line: total,
      over: toOdd(outcomes['12']),
      under: toOdd(outcomes['13']),
      outcome_over_id: '12',
      outcome_under_id: '13'
    });
  }

  return [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([inning, rows]) => ({
      market_id: '288',
      key: `inning_${inning}_total`,
      name: `${inning === 1 ? 'First' : inning === 2 ? 'Second' : `${inning}th`} inning - total`,
      inning,
      selections: rows.sort((a, b) => a.line - b.line)
    }));
}

function baseballRaceToRunsCard(event) {
  const [home, away] = competitorNames(event);
  const market = event?.markets?.['50083'];
  if (!market) return null;

  const rows = [];

  for (const [param, outcomes] of Object.entries(market)) {
    const runs = numberParam(param, 'runnr');
    if (runs === null) continue;

    rows.push({
      runs,
      home: { label: home, outcome_id: '6', odd: toOdd(outcomes['6']) },
      none: { label: 'None', outcome_id: '7', odd: toOdd(outcomes['7']) },
      away: { label: away, outcome_id: '8', odd: toOdd(outcomes['8']) }
    });
  }

  rows.sort((a, b) => a.runs - b.runs);

  return {
    market_id: '50083',
    key: 'race_to_runs',
    name: 'Race to runs',
    selections: rows
  };
}

function baseballKnownCards(event) {
  const [home, away] = competitorNames(event);
  const cards = [];
  const push = card => {
    if (card) cards.push(card);
  };

  push(baseballWinnerCard(event));
  push(baseballHandicapCard(event));
  push(baseballTotalCard(event, '258', 'total_including_extra_innings', 'Total (incl. extra innings)'));
  push(baseballTotalCard(event, '260', 'home_total_including_extra_innings', `${home} total (incl. extra innings)`));
  push(baseballTotalCard(event, '261', 'away_total_including_extra_innings', `${away} total (incl. extra innings)`));

  push(baseballFiveInnings1x2Card(event));
  push(baseballTotalCard(event, '276', 'innings_1_to_5_total', 'Innings 1 to 5 - total'));
  push(baseballTotalCard(event, '277', 'innings_1_to_5_home_total', `Innings 1 to 5 - ${home} total`));
  push(baseballTotalCard(event, '278', 'innings_1_to_5_away_total', `Innings 1 to 5 - ${away} total`));

  for (const card of baseballInning1x2Cards(event)) push(card);
  for (const card of baseballInningTotalCards(event)) push(card);

  push(baseballOddEvenCard(event));
  push(baseballExtraInningCard(event));
  push(baseballRaceToRunsCard(event));

  return cards;
}

function normalizeBaseballEvent(eventId, event, categories, tournaments, eventUrl) {
  const desc = event?.desc;
  if (!desc || String(desc.sport) !== BASEBALL_SPORT_ID) return null;
  if (desc.virtual === true) return null;
  if (!Array.isArray(desc.competitors) || desc.competitors.length < 2) return null;

  const now = Math.floor(Date.now() / 1000);

  if (desc.scheduled && desc.scheduled < now - 60) return null;

  if (HOURS_AHEAD > 0 && desc.scheduled) {
    const max = now + HOURS_AHEAD * 3600;
    if (desc.scheduled > max) return null;
  }

  const rawMarketIds = Object.keys(event.markets || {});

  const normalizedMarketIds = new Set([
    '251', '256', '258', '260', '261', '264', '268',
    '274', '276', '277', '278', '287', '288', '50083'
  ]);

  const recognizedPlayerPropIds = new Set([
    '781',   // Batter hits
    '782',   // Batter home runs
    '785',   // Batter total bases
    '925',   // Pitcher strikeouts
    '50212', // Same game accumulators
    '50213', // Same game accumulators cross team
    '50266', // Player performance double
    '50267'  // Player statistic double
  ]);

  const knownCards = baseballKnownCards(event);
  const playerPropMarketIds = rawMarketIds.filter(id => recognizedPlayerPropIds.has(id));
  const unmappedMarketIds = rawMarketIds.filter(
    id => !normalizedMarketIds.has(id) && !recognizedPlayerPropIds.has(id)
  );

  const markets = {
    winner_summary: baseballWinnerSummary(event),
    cards: knownCards
  };

  if (INCLUDE_RAW) {
    markets.raw = event.markets || {};
  }

  return {
    event_id: eventId,
    sport: 'Baseball',
    sport_id: BASEBALL_SPORT_ID,
    category: resolveCategory(categories, desc.category),
    tournament: resolveTournament(tournaments, desc.tournament),
    virtual: false,
    scheduled_unix: desc.scheduled || null,
    scheduled_utc: isoTime(desc.scheduled),
    scheduled_brazil: brazilTime(desc.scheduled),
    competitor_1: {
      id: desc.competitors[0]?.id || null,
      name: desc.competitors[0]?.name?.trim() || null,
      country_code: desc.competitors[0]?.country_code || null
    },
    competitor_2: {
      id: desc.competitors[1]?.id || null,
      name: desc.competitors[1]?.name?.trim() || null,
      country_code: desc.competitors[1]?.country_code || null
    },
    player_props: desc.player_props === true,
    bet_builder: desc.bet_builder === true,
    raw_market_count: rawMarketIds.length,
    raw_market_ids: rawMarketIds,
    known_market_card_count: knownCards.length,
    recognized_player_prop_market_count: playerPropMarketIds.length,
    recognized_player_prop_market_ids: playerPropMarketIds,
    player_prop_names_resolved: false,
    unmapped_market_count: unmappedMarketIds.length,
    unmapped_market_ids: unmappedMarketIds,
    markets,
    source_event_url: eventUrl
  };
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;

      try {
        results[index] = await mapper(items[index], index);
      } catch {
        results[index] = null;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, Math.max(items.length, 1)) },
      () => worker()
    )
  );

  return results;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetryStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

async function fetchEventDetail(context, page, apiOrigin, eventId, categories, tournaments) {
  const eventUrl =
    `${apiOrigin}/api/v4/prematch/brand/${BRAND_ID}/event/en/${eventId}`;

  let detail = null;
  let lastStatus = null;
  let lastError = null;

  // 1) Tentativa HTTP pelo APIRequestContext, como nas versões anteriores.
  // Enviamos também Origin/Referer, porque alguns shards/CDNs podem tratar
  // requisições "soltas" de forma diferente daquelas feitas pelo frontend.
  const apiDelays = [0, 700, 1800];

  for (let attempt = 0; attempt < apiDelays.length; attempt += 1) {
    if (apiDelays[attempt] > 0) {
      await sleep(apiDelays[attempt]);
    }

    try {
      const resp = await context.request.get(eventUrl, {
        headers: {
          accept: 'application/json',
          origin: 'https://csgoempire.com',
          referer: `${MATCH_BETTING_URL}`
        },
        timeout: 30000
      });

      lastStatus = resp.status();

      if (resp.ok()) {
        detail = await resp.json();
        break;
      }

      if (!shouldRetryStatus(lastStatus)) {
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  // 2) Fallback: faz o GET de dentro da página Chromium já aberta.
  // Não abre nova aba/página. Isso reproduz melhor a requisição do frontend
  // e reaproveita o contexto/origem real do navegador.
  if (!detail && page) {
    const browserDelays = [0, 900, 2200];

    for (let attempt = 0; attempt < browserDelays.length; attempt += 1) {
      if (browserDelays[attempt] > 0) {
        await sleep(browserDelays[attempt]);
      }

      try {
        const result = await page.evaluate(async url => {
          try {
            const response = await fetch(url, {
              method: 'GET',
              credentials: 'include',
              cache: 'no-store',
              headers: {
                accept: 'application/json'
              }
            });

            const text = await response.text();

            return {
              ok: response.ok,
              status: response.status,
              text
            };
          } catch (error) {
            return {
              ok: false,
              status: 0,
              text: '',
              error: String(error?.message || error)
            };
          }
        }, eventUrl);

        lastStatus = result?.status ?? lastStatus;

        if (result?.ok) {
          detail = JSON.parse(result.text);
          console.log(`Detalhe ${eventId}: fallback pelo browser OK`);
          break;
        }

        if (!shouldRetryStatus(lastStatus)) {
          lastError = new Error(result?.error || `HTTP ${lastStatus}`);
          break;
        }
      } catch (err) {
        lastError = err;
      }
    }
  }

  if (!detail) {
    const statusText = lastStatus ? `HTTP ${lastStatus}` : 'sem status HTTP';
    const extra = lastError?.message ? ` - ${lastError.message}` : '';
    throw new Error(`${statusText} após retry + fallback browser${extra}`);
  }

  if (detail.categories) deepMerge(categories, detail.categories);
  if (detail.tournaments) deepMerge(tournaments, detail.tournaments);

  return {
    eventUrl,
    event: detail?.events?.[eventId] || null
  };
}


async function main() {
  console.log('CSGOEmpire Tennis + CS2 + Football + Basketball + Baseball Collector v1.5.1');
  console.log(`Abrindo ${MATCH_BETTING_URL}`);
  console.log(`Modo: ${HEADLESS ? 'headless' : 'janela visível'}`);
  console.log(`Janela de captura: ${WAIT_MS} ms`);
  console.log(`Eventos: agora até +${HOURS_AHEAD || 'sem limite'}h`);
  console.log(`Esportes: ${ONLY}`);
  console.log(`Concorrência HTTP: ${CONCURRENCY}`);

  if (!['all', 'tennis', 'cs2', 'football', 'basketball', 'baseball'].includes(ONLY)) {
    throw new Error('--only deve ser all, tennis, cs2, football, basketball ou baseball');
  }

  const browser = await chromium.launch({ headless: HEADLESS });

  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'America/Sao_Paulo'
  });

  const page = await context.newPage();

  const mergedEvents = {};
  const categories = {};
  const tournaments = {};
  const sports = {};
  const eventIds = new Set();

  let apiOrigin = null;
  let prematchResponses = 0;

  page.on('response', async response => {
    const url = response.url();

    if (!url.includes('/api/v4/prematch/brand/')) return;
    if (!url.includes(`/${BRAND_ID}/`)) return;
    if (url.includes('/event/')) return;

    try {
      const u = new URL(url);
      apiOrigin = u.origin;

      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;

      const data = await response.json();
      prematchResponses += 1;

      if (data.sports) deepMerge(sports, data.sports);
      if (data.categories) deepMerge(categories, data.categories);
      if (data.tournaments) deepMerge(tournaments, data.tournaments);

      if (data.events) {
        for (const [eventId, patch] of Object.entries(data.events)) {
          eventIds.add(eventId);

          if (patch === null) {
            delete mergedEvents[eventId];
            continue;
          }

          mergedEvents[eventId] = deepMerge(mergedEvents[eventId], patch);
        }
      }
    } catch {
      // Ignora respostas parciais/interrompidas.
    }
  });

  try {
    await page.goto(MATCH_BETTING_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    console.log('Página carregada. Coletando feed prematch...');
    await page.waitForTimeout(WAIT_MS);
  } catch (err) {
    console.error('Aviso ao carregar página:', err.message);
  }

  if (!apiOrigin) {
    await browser.close();

    throw new Error(
      'Nenhum endpoint prematch foi capturado. ' +
      'Rode sem --headless e tente --wait=30000.'
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const maxTime =
    HOURS_AHEAD > 0
      ? now + HOURS_AHEAD * 3600
      : Number.MAX_SAFE_INTEGER;

  const withinWindow = d =>
    d &&
    d.virtual !== true &&
    (!d.scheduled || (
      d.scheduled >= now - 60 &&
      d.scheduled <= maxTime
    ));

  const tennisIds = Object.entries(mergedEvents)
    .filter(([, e]) =>
      withinWindow(e?.desc) &&
      String(e.desc.sport) === TENNIS_SPORT_ID
    )
    .map(([id]) => id);

  const cs2Ids = Object.entries(mergedEvents)
    .filter(([, e]) =>
      withinWindow(e?.desc) &&
      String(e.desc.sport) === CS2_SPORT_ID
    )
    .map(([id]) => id);

  const footballIds = Object.entries(mergedEvents)
    .filter(([, e]) =>
      withinWindow(e?.desc) &&
      String(e.desc.sport) === FOOTBALL_SPORT_ID
    )
    .map(([id]) => id);

  const basketballIds = Object.entries(mergedEvents)
    .filter(([, e]) =>
      withinWindow(e?.desc) &&
      String(e.desc.sport) === BASKETBALL_SPORT_ID
    )
    .map(([id]) => id);

  const baseballIds = Object.entries(mergedEvents)
    .filter(([, e]) =>
      withinWindow(e?.desc) &&
      String(e.desc.sport) === BASEBALL_SPORT_ID
    )
    .map(([id]) => id);

  console.log(`Responses prematch capturados: ${prematchResponses}`);
  console.log(`Eventos vistos no feed: ${eventIds.size}`);
  console.log(`Tênis candidato: ${tennisIds.length}`);
  console.log(`CS2 candidato: ${cs2Ids.length}`);
  console.log(`Futebol candidato: ${footballIds.length}`);
  console.log(`Basquete candidato: ${basketballIds.length}`);
  console.log(`Baseball candidato: ${baseballIds.length}`);

  let tennisEvents = [];
  let cs2Events = [];
  let footballEvents = [];
  let basketballEvents = [];
  let baseballEvents = [];

  if (ONLY === 'all' || ONLY === 'tennis') {
    const rows = await mapLimit(
      tennisIds,
      CONCURRENCY,
      async eventId => {
        try {
          const { eventUrl, event } = await fetchEventDetail(
            context,
            page,
            apiOrigin,
            eventId,
            categories,
            tournaments
          );

          const fullEvent = event || mergedEvents[eventId];

          return normalizeEvent(
            eventId,
            fullEvent,
            categories,
            tournaments,
            eventUrl
          );
        } catch (err) {
          console.warn(`Tênis ${eventId}: ${err.message}`);
          return null;
        }
      }
    );

    tennisEvents = rows
      .filter(Boolean)
      .sort((a, b) => (a.scheduled_unix || 0) - (b.scheduled_unix || 0));
  }

  if (ONLY === 'all' || ONLY === 'cs2') {
    const rows = await mapLimit(
      cs2Ids,
      CONCURRENCY,
      async eventId => {
        try {
          const { eventUrl, event } = await fetchEventDetail(
            context,
            page,
            apiOrigin,
            eventId,
            categories,
            tournaments
          );

          const fullEvent = event || mergedEvents[eventId];

          return normalizeCs2Event(
            eventId,
            fullEvent,
            categories,
            tournaments,
            eventUrl
          );
        } catch (err) {
          console.warn(`CS2 ${eventId}: ${err.message}`);
          return null;
        }
      }
    );

    cs2Events = rows
      .filter(Boolean)
      .sort((a, b) => (a.scheduled_unix || 0) - (b.scheduled_unix || 0));
  }


  if (ONLY === 'all' || ONLY === 'football') {
    const rows = await mapLimit(
      footballIds,
      CONCURRENCY,
      async eventId => {
        try {
          const { eventUrl, event } = await fetchEventDetail(
            context,
            page,
            apiOrigin,
            eventId,
            categories,
            tournaments
          );

          const fullEvent = event || mergedEvents[eventId];

          return normalizeFootballEvent(
            eventId,
            fullEvent,
            categories,
            tournaments,
            eventUrl
          );
        } catch (err) {
          console.warn(`Futebol ${eventId}: ${err.message}`);
          return null;
        }
      }
    );

    footballEvents = rows
      .filter(Boolean)
      .sort((a, b) => (a.scheduled_unix || 0) - (b.scheduled_unix || 0));
  }


  if (ONLY === 'all' || ONLY === 'basketball') {
    const rows = await mapLimit(
      basketballIds,
      CONCURRENCY,
      async eventId => {
        try {
          const { eventUrl, event } = await fetchEventDetail(
            context,
            page,
            apiOrigin,
            eventId,
            categories,
            tournaments
          );

          const fullEvent = event || mergedEvents[eventId];

          return normalizeBasketballEvent(
            eventId,
            fullEvent,
            categories,
            tournaments,
            eventUrl
          );
        } catch (err) {
          console.warn(`Basquete ${eventId}: ${err.message}`);
          return null;
        }
      }
    );

    basketballEvents = rows
      .filter(Boolean)
      .sort((a, b) => (a.scheduled_unix || 0) - (b.scheduled_unix || 0));
  }


  if (ONLY === 'all' || ONLY === 'baseball') {
    const rows = await mapLimit(
      baseballIds,
      CONCURRENCY,
      async eventId => {
        try {
          const { eventUrl, event } = await fetchEventDetail(
            context,
            page,
            apiOrigin,
            eventId,
            categories,
            tournaments
          );

          const fullEvent = event || mergedEvents[eventId];

          return normalizeBaseballEvent(
            eventId,
            fullEvent,
            categories,
            tournaments,
            eventUrl
          );
        } catch (err) {
          console.warn(`Baseball ${eventId}: ${err.message}`);
          return null;
        }
      }
    );

    baseballEvents = rows
      .filter(Boolean)
      .sort((a, b) => (a.scheduled_unix || 0) - (b.scheduled_unix || 0));
  }

  const result = {
    collector: 'csgoempire-tennis-cs2-football-basketball-baseball',
    version: '1.5.1',
    generated_at_utc: new Date().toISOString(),
    source: {
      site: 'CSGOEmpire Match Betting',
      provider_feed: 'BETBY/sptpub prematch',
      brand_id: BRAND_ID,
      api_origin: apiOrigin,
      detail_fetch_strategy: 'APIRequestContext with retry -> browser fetch fallback'
    },
    filters: {
      only: ONLY,
      exclude_virtual: true,
      upcoming_only: true,
      hours_ahead: HOURS_AHEAD
    },
    sport_ids: {
      tennis: TENNIS_SPORT_ID,
      counter_strike: CS2_SPORT_ID,
      football: FOOTBALL_SPORT_ID,
      basketball: BASKETBALL_SPORT_ID,
      baseball: BASEBALL_SPORT_ID
    },
    cs2_mapping_note:
      'CS2 mantém markets.raw completo para não perder nenhum mercado. ' +
      'Os cards normalizados são apenas os IDs já confirmados por comparação ' +
      'entre o endpoint e a interface do CSGOEmpire.',
    cs2_known_market_ids: {
      '186': 'Winner',
      '327': 'Map handicap',
      '328': 'Total maps',
      '330': 'Map winner',
      '331': 'Map round handicap',
      '332': 'Map total rounds',
      '334': 'Map 1x2 (excluding overtime)',
      '50112': 'Pistol round winner',
      '50339': 'Map winner & total rounds'
    },

    football_mapping_note:
      'Futebol mantém os IDs crus de todos os mercados e normaliza os principais ' +
      'mercados confirmados por comparação entre o endpoint e a interface do CSGOEmpire. ' +
      'Use --include-raw para incluir o bloco raw completo, que pode deixar o JSON muito grande.',
    football_known_market_ids: {
      '1': '1x2',
      '8': 'First team to score / Goal',
      '10': 'Double chance',
      '11': 'Draw no bet',
      '16': 'Handicap / Asian handicap',
      '18': 'Total goals',
      '19': 'Home team total',
      '20': 'Away team total',
      '29': 'Both teams to score',
      '35': '1x2 & both teams to score',
      '36': 'Total & both teams to score',
      '37': '1x2 & total',
      '60': '1st half - 1x2',
      '68': '1st half - total',
      '162': 'Corner 1x2',
      '166': 'Total corners',
      '177': '1st half - total corners',
      '562': 'Both teams to score in both halves',
      '50305': 'Will be a penalty'
    },

    basketball_mapping_note:
      'Basketball sport_id 2. A amostra El Calor de Cancun x Astros de Jalisco ' +
      'teve 25 IDs brutos e todos os 25 foram mapeados nesta versão. Mercados de ' +
      'outras ligas que usem IDs adicionais continuam listados em unmapped_market_ids.',
    basketball_known_market_ids: {
      '1': '1x2',
      '10': 'Double chance',
      '60': '1st half - 1x2',
      '66': '1st half - handicap',
      '68': '1st half - total',
      '69': '1st half - home team total',
      '70': '1st half - away team total',
      '74': '1st half - odd/even',
      '219': 'Winner (incl. overtime)',
      '220': 'Will there be overtime',
      '223': 'Handicap (incl. overtime)',
      '225': 'Total (incl. overtime)',
      '227': 'Home team total (incl. overtime)',
      '228': 'Away team total (incl. overtime)',
      '229': 'Odd/even (incl. overtime)',
      '235': 'Quarter - 1x2',
      '236': 'Quarter - total',
      '292': 'Winner & total (incl. overtime)',
      '303': 'Quarter - handicap',
      '304': 'Quarter - odd/even',
      '756': 'Quarter - home team total',
      '757': 'Quarter - away team total',
      '1175': '1st quarter - winner & total',
      '1177': '1st half - winner & total',
      '50010': 'Quarter - race to points (3 way)'
    },
    basketball_recognized_player_prop_ids: {
      '768': 'Player points - X+',
      '770': 'Player assists - X+',
      '772': 'Player rebounds - X+',
      '774': 'Player 3-point field goals - X+',
      '921': 'Player points - over/under',
      '922': 'Player assists - over/under',
      '923': 'Player rebounds - over/under',
      '924': 'Player 3-point field goals - over/under',
      '50212': 'Same game accumulators',
      '50213': 'Same game accumulators cross team',
      '50266': 'Player performance double',
      '50267': 'Player statistic double',
      '50268': 'Player statistic triple',
      '50286': 'Points + rebounds + assists - over/under',
      '50287': 'Points + rebounds + assists - X+',
      '50288': 'Rebounds + assists - X+'
    },
    baseball_mapping_note:
      'Baseball sport_id 3. Os mercados principais foram confirmados com ' +
      'Los Angeles Angels x Cleveland Guardians (MLB). Player Props identificados ' +
      'ficam reconhecidos por ID, mas nomes de jogadores não são resolvidos pelo /event.',
    baseball_known_market_ids: {
      '251': 'Winner (incl. extra innings)',
      '256': 'Handicap (incl. extra innings)',
      '258': 'Total (incl. extra innings)',
      '260': 'Home team total (incl. extra innings)',
      '261': 'Away team total (incl. extra innings)',
      '264': 'Odd/even (incl. extra innings)',
      '268': 'Will there be an extra inning',
      '274': 'Innings 1 to 5 - 1x2',
      '276': 'Innings 1 to 5 - total',
      '277': 'Innings 1 to 5 - home team total',
      '278': 'Innings 1 to 5 - away team total',
      '287': 'Inning - 1x2',
      '288': 'Inning - total',
      '50083': 'Race to runs'
    },
    baseball_recognized_player_prop_ids: {
      '781': 'Batter hits',
      '782': 'Batter home runs',
      '785': 'Batter total bases',
      '925': 'Pitcher strikeouts',
      '50212': 'Same game accumulators',
      '50213': 'Same game accumulators cross team',
      '50266': 'Player performance double',
      '50267': 'Player statistic double'
    },
    totals: {
      tennis_events: tennisEvents.length,
      cs2_events: cs2Events.length,
      football_events: footballEvents.length,
      basketball_events: basketballEvents.length,
      baseball_events: baseballEvents.length,
      all_events: tennisEvents.length + cs2Events.length + footballEvents.length + basketballEvents.length + baseballEvents.length
    },
    tennis: {
      sport_id: TENNIS_SPORT_ID,
      event_count: tennisEvents.length,
      events: tennisEvents
    },
    cs2: {
      sport_id: CS2_SPORT_ID,
      event_count: cs2Events.length,
      events: cs2Events
    },
    football: {
      sport_id: FOOTBALL_SPORT_ID,
      event_count: footballEvents.length,
      events: footballEvents
    },
    basketball: {
      sport_id: BASKETBALL_SPORT_ID,
      event_count: basketballEvents.length,
      events: basketballEvents
    },
    baseball: {
      sport_id: BASEBALL_SPORT_ID,
      event_count: baseballEvents.length,
      events: baseballEvents
    }
  };

  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify(result, null, 2),
    'utf8'
  );

  console.log('');
  console.log(`OK: ${result.totals.all_events} eventos salvos em:`);
  console.log(OUT_FILE);
  console.log(`Tênis: ${tennisEvents.length}`);
  console.log(`CS2: ${cs2Events.length}`);
  console.log(`Futebol: ${footballEvents.length}`);
  console.log(`Basquete: ${basketballEvents.length}`);
  console.log(`Baseball: ${baseballEvents.length}`);

  if (cs2Events.length > 0) {
    console.log('');
    console.log('Primeiros eventos CS2:');

    for (const e of cs2Events.slice(0, 10)) {
      const winner = e.markets?.winner_summary;
      const a = winner?.selections?.[0];
      const b = winner?.selections?.[1];

      console.log(
        `- ${e.competitor_1.name} (${a?.odd ?? '-'}) x ` +
        `${e.competitor_2.name} (${b?.odd ?? '-'}) | ` +
        `${e.scheduled_brazil || ''} | ` +
        `${e.raw_market_count} IDs (${e.unmapped_market_count} ainda crus)`
      );
    }
  }

  if (footballEvents.length > 0) {
    console.log('');
    console.log('Primeiros eventos Futebol:');

    for (const e of footballEvents.slice(0, 10)) {
      const market = e.markets?.winner_summary;
      const h = market?.selections?.[0];
      const d = market?.selections?.[1];
      const a = market?.selections?.[2];

      console.log(
        `- ${e.competitor_1.name} (${h?.odd ?? '-'}) x ` +
        `${e.competitor_2.name} (${a?.odd ?? '-'}) | ` +
        `empate ${d?.odd ?? '-'} | ${e.scheduled_brazil || ''} | ` +
        `${e.raw_market_count} IDs (${e.unmapped_market_count} ainda crus)`
      );
    }
  }

  if (basketballEvents.length > 0) {
    console.log('');
    console.log('Primeiros eventos Basquete:');

    for (const e of basketballEvents.slice(0, 10)) {
      const market = e.markets?.winner_summary;
      const h = market?.selections?.[0];
      const a = market?.selections?.[1];

      console.log(
        `- ${e.competitor_1.name} (${h?.odd ?? '-'}) x ` +
        `${e.competitor_2.name} (${a?.odd ?? '-'}) | ` +
        `${e.scheduled_brazil || ''} | ` +
        `${e.raw_market_count} IDs (${e.unmapped_market_count} ainda crus)`
      );
    }
  }

  if (baseballEvents.length > 0) {
    console.log('');
    console.log('Primeiros eventos Baseball:');

    for (const e of baseballEvents.slice(0, 10)) {
      const market = e.markets?.winner_summary;
      const h = market?.selections?.[0];
      const a = market?.selections?.[1];

      console.log(
        `- ${e.competitor_1.name} (${h?.odd ?? '-'}) x ` +
        `${e.competitor_2.name} (${a?.odd ?? '-'}) | ` +
        `${e.scheduled_brazil || ''} | ` +
        `${e.raw_market_count} IDs (${e.unmapped_market_count} não classificados)`
      );
    }
  }

  await browser.close();
}

main().catch(err => {
  console.error('');
  console.error('ERRO:', err.message);
  process.exit(1);
});
