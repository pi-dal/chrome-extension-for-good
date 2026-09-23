import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { debugPortHint, pickNewTarget, type CdpTargetInfo } from '../src/cdp.js';

/**
 * Only the pure helpers are covered here: everything else in cdp.ts needs a
 * live DevTools endpoint. `pickNewTarget` is what lets a swarm lane attach to
 * its tab even when the park URL redirected away from its marker.
 */

function target(id: string, url: string, type = 'page'): CdpTargetInfo {
  return { id, type, url, title: '', webSocketDebuggerUrl: type === 'page' ? `ws://127.0.0.1:9222/devtools/page/${id}` : undefined };
}

describe('pickNewTarget', () => {
  it('returns the page target that was not there before', () => {
    const targets = [target('a', 'https://lms.example.com/course/view.php?id=1'), target('b', 'https://cas.example.com/login')];
    assert.equal(pickNewTarget(targets, ['a'])?.id, 'b');
  });

  it('ignores non-page targets and targets without a debugger url', () => {
    const targets = [target('svc', 'https://lms.example.com/sw.js', 'service_worker'), target('nourl', 'https://x/')];
    targets[1]!.webSocketDebuggerUrl = undefined;
    assert.equal(pickNewTarget(targets, []), null);
  });

  it('returns null when nothing is new', () => {
    assert.equal(pickNewTarget([target('a', 'https://x/')], ['a']), null);
    assert.equal(pickNewTarget([], []), null);
  });
});

describe('debugPortHint', () => {
  it('names the port and the exact Chrome flag', () => {
    const hint = debugPortHint(9333);
    assert.match(hint, /9333/);
    assert.match(hint, /--remote-debugging-port=9333/);
  });
});
