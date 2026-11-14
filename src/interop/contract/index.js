// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 dsh-Fang/dsh-Master contributors — see LICENSE.

/**
 * @twinsearth/dsh-fang-contract
 *
 * 瓮城（dsh-Fang）↔ 房主（dsh-Master）的独立版本化互联 SDK。
 * 设计目标：
 *   1. 双方独立升级：语义化版本 + hello 协商 + 未知字段忽略 + 方法版本裁剪；
 *   2. 互联互通保底：local → http → file → legacy 四级传输自动降级；
 *   3. 接口包可独立替换：更新本包即升级接口架构，旧方法在 MAJOR 内保持可调用。
 */

export * from './constants.js'
export * from './envelope.js'
export * from './negotiate.js'
export * from './server.js'
export * from './relay.js'
export * from './transports.js'
export * from './client.js'
