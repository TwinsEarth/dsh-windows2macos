#!/usr/bin/env node
/* eslint-disable no-irregular-whitespace -- board art uses the middle dot as an empty square */
/**
 * 中国象棋三方联合演示：主机裁判，两台编队成员对弈。
 *
 * 本脚本用确定性的"玩家"代替真人，用于验证规则、回放格式与三方消息格式；
 * 真人接入时由裁判读取棋手在编队聊天里发的着法（a4-a5），校验后广播同一份棋盘+进度。
 *
 * 用法：node scripts/xiangqi-demo.mjs [--max-ply 120]
 */
import { allLegalMoves, applyMove, boardAscii, createGame, describeProgress, moveText } from '../src/game/xiangqi.mjs';

const arg = (name, fallback) => {
  const index = process.argv.indexOf('--' + name);
  return index >= 0 && process.argv[index + 1] ? Number(process.argv[index + 1]) : fallback;
};
const MAX_PLY = arg('max-ply', 120);
const PLAYERS = { r: 'DSH', b: 'macmini' };
const HOST = 'ToFuture';
const VALUE = { K: 1000, R: 9, C: 5, H: 4, E: 2, A: 2, P: 1 };

let seed = 20261029;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

/** 简单但合法的棋手策略：优先吃大子，否则在合法着法里确定性地挑一个。 */
function chooseMove(game) {
  const moves = allLegalMoves(game.board, game.turn);
  if (moves.length === 0) return null;
  let best = -1; let pool = [];
  for (const move of moves) {
    const target = game.board[move.to[0]][move.to[1]];
    const score = target === null ? 0 : VALUE[target.toUpperCase()] ?? 0;
    if (score > best) { best = score; pool = [move]; } else if (score === best) pool.push(move);
  }
  return pool[Math.floor(random() * pool.length)];
}

const game = createGame();
const transcript = [];
const push = (text) => { transcript.push(text); console.log(text); };

push('中国象棋 · 联合开发/编队协作演示');
push(`主机裁判：${HOST}　红方：${PLAYERS.r}　黑方：${PLAYERS.b}`);
push('');
push(boardAscii(game));
push(describeProgress(game));
push('');

let current = game;
for (let ply = 0; ply < MAX_PLY && current.result === null; ply += 1) {
  const move = chooseMove(current);
  if (move === null) break;
  const result = applyMove(current, move.from, move.to);
  if (result.ok !== true) { push('裁判拒绝：' + result.code); break; }
  current = result.state;
  const actor = result.move.piece === result.move.piece.toUpperCase() ? PLAYERS.r : PLAYERS.b;
  push(`${actor}：${moveText(result.move)}${result.move.captured ? ' 吃 ' + result.move.captured : ''}`);
  push(boardAscii(current));
  push(describeProgress(current));
  push('');
}

push('最终结果');
push(describeProgress(current));
if (current.result !== null) push(`胜方：${PLAYERS[current.result.winner]}（${current.result.reason}）`);
push(`总手数：${current.ply}`);
