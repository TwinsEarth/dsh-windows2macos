/**
 * 中国象棋核心规则（联合开发演示用，零依赖）。
 *
 * 棋盘 10 行 × 9 列：row 0 为黑方底线，row 9 为红方底线；红先。
 * 棋子：K 帅/将, A 仕/士, E 相/象, H 马, R 车, C 炮, P 兵/卒。
 * 已实现：全部走子规则、炮架、马腿、象眼、过河兵、九宫、飞将、将军/将死/困毙（困毙判负）。
 */
export const COLS = 9;
export const ROWS = 10;
const RED = 'r';
const BLACK = 'b';

const START = [
  ['r', 'h', 'e', 'a', 'k', 'a', 'e', 'h', 'r'],
  [null, null, null, null, null, null, null, null, null],
  [null, 'c', null, null, null, null, null, 'c', null],
  ['p', null, 'p', null, 'p', null, 'p', null, 'p'],
  [null, null, null, null, null, null, null, null, null],
  [null, null, null, null, null, null, null, null, null],
  ['P', null, 'P', null, 'P', null, 'P', null, 'P'],
  [null, 'C', null, null, null, null, null, 'C', null],
  [null, null, null, null, null, null, null, null, null],
  ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'],
];

const isRed = (piece) => piece !== null && piece === piece.toUpperCase();
const sideOf = (piece) => (piece === null ? null : isRed(piece) ? RED : BLACK);

export function createGame() {
  return {
    board: START.map((row) => row.slice()),
    turn: RED,
    ply: 0,
    history: [],
    result: null,
  };
}

const cloneBoard = (board) => board.map((row) => row.slice());
const inBoard = (r, c) => r >= 0 && r < ROWS && c >= 0 && c < COLS;
const inPalace = (side, r, c) => {
  if (c < 3 || c > 5) return false;
  return side === RED ? r >= 7 && r <= 9 : r >= 0 && r <= 2;
};
const crossedRiver = (side, r) => (side === RED ? r <= 4 : r >= 5);

function pseudoMoves(board, side, r, c) {
  const piece = board[r][c];
  if (piece === null || sideOf(piece) !== side) return [];
  const type = piece.toUpperCase();
  const out = [];
  const push = (rr, cc) => {
    if (!inBoard(rr, cc)) return;
    const target = board[rr][cc];
    if (target === null || sideOf(target) !== side) out.push([rr, cc]);
  };
  if (type === 'K') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const rr = r + dr; const cc = c + dc;
      if (inPalace(side, rr, cc)) push(rr, cc);
    }
  } else if (type === 'A') {
    for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const rr = r + dr; const cc = c + dc;
      if (inPalace(side, rr, cc)) push(rr, cc);
    }
  } else if (type === 'E') {
    for (const [dr, dc] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
      const rr = r + dr; const cc = c + dc;
      if (!inBoard(rr, cc) || crossedRiver(side, rr)) continue;
      if (board[r + dr / 2][c + dc / 2] !== null) continue;
      push(rr, cc);
    }
  } else if (type === 'H') {
    for (const [dr, dc, lr, lc] of [
      [2, 1, 1, 0], [2, -1, 1, 0], [-2, 1, -1, 0], [-2, -1, -1, 0],
      [1, 2, 0, 1], [-1, 2, 0, 1], [1, -2, 0, -1], [-1, -2, 0, -1],
    ]) {
      const rr = r + dr; const cc = c + dc;
      if (!inBoard(rr, cc)) continue;
      if (board[r + lr][c + lc] !== null) continue;
      push(rr, cc);
    }
  } else if (type === 'R' || type === 'C') {
    for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      let rr = r + dr; let cc = c + dc; let screen = false;
      while (inBoard(rr, cc)) {
        const target = board[rr][cc];
        if (type === 'R') {
          if (target === null) out.push([rr, cc]);
          else { if (sideOf(target) !== side) out.push([rr, cc]); break; }
        } else if (target === null) {
          if (!screen) out.push([rr, cc]);
        } else if (!screen) {
          screen = true;
        } else {
          if (sideOf(target) !== side) out.push([rr, cc]);
          break;
        }
        rr += dr; cc += dc;
      }
    }
  } else if (type === 'P') {
    const forward = side === RED ? -1 : 1;
    push(r + forward, c);
    if (crossedRiver(side, r)) { push(r, c - 1); push(r, c + 1); }
  }
  return out;
}

function kingAt(board, side) {
  for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS; c += 1) {
    const p = board[r][c];
    if (p !== null && p.toUpperCase() === 'K' && sideOf(p) === side) return [r, c];
  }
  return null;
}

function kingsFace(board) {
  const rk = kingAt(board, RED); const bk = kingAt(board, BLACK);
  if (rk === null || bk === null || rk[1] !== bk[1]) return false;
  const c = rk[1];
  const from = Math.min(rk[0], bk[0]) + 1; const to = Math.max(rk[0], bk[0]);
  for (let r = from; r < to; r += 1) if (board[r][c] !== null) return false;
  return true;
}

/** 某方是否被将军（含飞将）。 */
export function inCheck(board, side) {
  if (kingsFace(board)) return true;
  const king = kingAt(board, side);
  if (king === null) return true;
  const enemy = side === RED ? BLACK : RED;
  for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS; c += 1) {
    const p = board[r][c];
    if (p === null || sideOf(p) !== enemy) continue;
    if (pseudoMoves(board, enemy, r, c).some(([rr, cc]) => rr === king[0] && cc === king[1])) return true;
  }
  return false;
}

export function legalMovesFrom(board, side, r, c) {
  return pseudoMoves(board, side, r, c).filter(([rr, cc]) => {
    const next = cloneBoard(board);
    next[rr][cc] = next[r][c]; next[r][c] = null;
    return !inCheck(next, side);
  });
}

export function allLegalMoves(board, side) {
  const out = [];
  for (let r = 0; r < ROWS; r += 1) for (let c = 0; c < COLS; c += 1) {
    if (board[r][c] !== null && sideOf(board[r][c]) === side) {
      for (const [rr, cc] of legalMovesFrom(board, side, r, c)) out.push({ from: [r, c], to: [rr, cc] });
    }
  }
  return out;
}

const FILE = 'abcdefghi';
export const squareName = (r, c) => FILE[c] + String(ROWS - r);

/** @returns {{ok: true, state: object, move: object} | {ok: false, code: string}} */
export function applyMove(game, from, to) {
  if (game.result !== null) return { ok: false, code: 'GAME_OVER' };
  if (!Array.isArray(from) || !Array.isArray(to) || !inBoard(from[0], from[1]) || !inBoard(to[0], to[1])) return { ok: false, code: 'SQUARE_INVALID' };
  const piece = game.board[from[0]][from[1]];
  if (piece === null || sideOf(piece) !== game.turn) return { ok: false, code: 'NOT_YOUR_PIECE' };
  const legal = legalMovesFrom(game.board, game.turn, from[0], from[1]);
  if (!legal.some(([r, c]) => r === to[0] && c === to[1])) return { ok: false, code: 'ILLEGAL_MOVE' };
  const board = cloneBoard(game.board);
  const captured = board[to[0]][to[1]];
  board[to[0]][to[1]] = piece; board[from[0]][from[1]] = null;
  const mover = game.turn;
  const next = { ...game, board, turn: mover === RED ? BLACK : RED, ply: game.ply + 1, history: [...game.history, { from, to, piece, captured }] };
  const opponentHasMoves = allLegalMoves(board, next.turn).length > 0;
  const opponentChecked = inCheck(board, next.turn);
  if (!opponentHasMoves) {
    next.result = { winner: mover, reason: captured !== null && captured.toUpperCase() === 'K' ? 'KING_CAPTURED' : opponentChecked ? 'CHECKMATE' : 'STALEMATE' };
  } else if (opponentChecked) {
    next.check = true;
  } else {
    next.check = false;
  }
  next.lastMove = { from, to, piece, captured, check: opponentChecked === true && next.result === null };
  return { ok: true, state: next, move: next.lastMove };
}

const GLYPH = { K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵', k: '将', a: '士', e: '象', h: '马', r: '车', c: '炮', p: '卒' };

export function boardAscii(game) {
  const lines = ['    a b c d e f g h i'];
  for (let r = 0; r < ROWS; r += 1) {
    const cells = [];
    for (let c = 0; c < COLS; c += 1) {
      const p = game.board[r][c];
      cells.push(p === null ? '·' : GLYPH[p] ?? p);
    }
    lines.push(String(ROWS - r).padStart(2, ' ') + '  ' + cells.join(' '));
  }
  lines.push('    a b c d e f g h i');
  return lines.join('\n');
}

export function moveText(move) {
  return squareName(move.from[0], move.from[1]) + '-' + squareName(move.to[0], move.to[1]);
}

export function describeProgress(game) {
  const side = game.turn === RED ? '红' : '黑';
  if (game.result !== null) {
    const winner = game.result.winner === RED ? '红方' : '黑方';
    return `第 ${game.ply} 手结束：${winner}胜（${game.result.reason}）`;
  }
  const last = game.lastMove ? `上一手 ${moveText(game.lastMove)}${game.lastMove.captured ? ' 吃 ' + GLYPH[game.lastMove.captured] : ''}` : '开局';
  return `第 ${game.ply} 手 · ${side}方行棋 · ${last}${game.check ? ' · 将军！' : ''}`;
}
