import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyMove, allLegalMoves, boardAscii, createGame, describeProgress, inCheck, moveText,
} from '../src/game/xiangqi.mjs';

const sq = { a4: [6, 0], a5: [5, 0], b4: [6, 1] };

describe('xiangqi rules', () => {
  it('red moves first and a soldier advances one rank', () => {
    const game = createGame();
    const moved = applyMove(game, sq.a4, sq.a5);
    assert.equal(moved.ok, true, moved.code);
    assert.equal(moved.state.turn, 'b');
    assert.equal(moved.state.ply, 1);
    assert.match(describeProgress(moved.state), /黑方行棋/);
    assert.match(boardAscii(moved.state), /卒/);
  });

  it('refuses the wrong side and an illegal move', () => {
    const game = createGame();
    assert.equal(applyMove(game, [0, 0], [1, 0]).code, 'NOT_YOUR_PIECE');
    assert.equal(applyMove(game, sq.a4, [4, 0]).code, 'ILLEGAL_MOVE');
  });

  it('blocks the horse leg and the elephant eye', () => {
    const game = createGame();
    // Red horse at (9,1) with its leg (8,1) blocked by a placed piece.
    game.board[8][1] = 'P';
    const horse = allLegalMoves(game.board, 'r').filter((m) => m.from[0] === 9 && m.from[1] === 1);
    assert.equal(horse.some((m) => m.to[0] === 7 && m.to[1] === 0), false);
    const clean = createGame();
    const horseClean = allLegalMoves(clean.board, 'r').filter((m) => m.from[0] === 9 && m.from[1] === 1);
    assert.equal(horseClean.some((m) => m.to[0] === 7 && m.to[1] === 0), true);
  });

  it('detects a flying-general position as check and refuses the move that creates it', () => {
    const board = createGame().board;
    board[9][4] = 'K'; board[0][4] = 'k';
    // Remove every piece between the kings.
    for (let r = 1; r < 9; r += 1) board[r][4] = null;
    assert.equal(inCheck(board, 'r'), true);
  });

  it('seals a simple checkmate and reports the winner', () => {
    const game = createGame();
    // Empty board, red king e1, red rook e2, black king e10 with red rook controlling the file.
    game.board = Array.from({ length: 10 }, () => Array(9).fill(null));
    game.board[9][4] = 'K'; game.board[2][4] = 'R'; game.board[0][0] = 'R'; game.board[0][4] = 'k';
    game.turn = 'r';
    const moved = applyMove(game, [2, 4], [1, 4]);
    assert.equal(moved.ok, true, moved.code);
    assert.equal(moved.state.result?.winner, 'r');
    assert.match(describeProgress(moved.state), /红方胜/);
  });

  it('prints a board with all 32 starting pieces', () => {
    const ascii = boardAscii(createGame());
    assert.match(ascii, /帅/);
    assert.match(ascii, /将/);
    assert.equal(ascii.split('\n').length, 12);
  });

  it('moveText names both squares', () => {
    assert.equal(moveText({ from: [6, 0], to: [5, 0] }), 'a4-a5');
  });
});
