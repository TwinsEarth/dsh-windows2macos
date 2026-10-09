/**
 * Package root entry.
 *
 * TWO READERS, ONE EXPORT LIST
 *
 * `cordis.patch.yml` names the `tools` subpath explicitly, and that stays true: mounting this
 * profile reads the patch, sees `@twinsearth/w2m-dsh-plugin/tools`, and loads `./tools.js`. Nothing
 * about the mounted plugin changes because of this file.
 *
 * But the root entry is what everything else looks at. The DSH plugin listing requirements -- and
 * the marketplace checklists that copy them -- ask for a package that "exports an `apply(ctx)`
 * module", and a package that does not is one of the most common reasons a submission is refused.
 * This file used to be documentation only, so importing the package root yielded **no exports at
 * all** (`Object.keys() === []`): a plugin that works perfectly when mounted by its patch and looks
 * like an empty package to every tool that inspects it. That is a bad trade for one re-export line.
 *
 * WHY NOT MOVE THE PLUGIN HERE
 *
 * Re-exporting is not relocating: `./tools.js` stays the single definition, so there is still
 * exactly one implementation of the plugin surface to keep in sync. Mounting *both* this entry and
 * the subpath would register the eight tools twice, which is why the patch keeps naming the subpath
 * instead of falling back to the "the root is the plugin" convention.
 */
export { apply, inject, resetDefineToolCacheForTests } from './tools.js';
