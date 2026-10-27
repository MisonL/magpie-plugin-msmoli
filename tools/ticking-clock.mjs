// A clock that moves a second per read, for the test code only.
//
// Three countdown tests used to build their fixture with one Date.now() call
// and compute the expected value with a second one, each truncated to whole
// seconds (at() in test/plugin.test.mjs). A wall-clock second boundary
// between the two made the fixture and the expectation a second apart, and
// the test went red about once in a thousand runs — seen once under a
// mutation and logged as unreproduced before it was traced.
//
// Under this shim every Date.now() read *from a test file* advances the
// clock by a second, so that shape fails every time instead of one run in a
// thousand. Reads from index.mjs keep real time: drifting the plugin's own
// clock would move `todayCN()` across a Beijing midnight on a long run and
// redden unrelated tests for a reason that is not theirs.
//
//   node --import ./tools/ticking-clock.mjs --test
//
// The stack check is what keeps it to the test files; it costs one Error per
// read, and the suite reads the clock a few hundred times in all. It takes the
// first frame outside this file — not a fixed depth: the shim's own frames
// move whenever a helper is added, and a fixed index silently went inert when
// one was. Looking at the whole stack instead would name a test file for
// every read the plugin makes too (the test called the plugin), and drifting
// the plugin's clock reddens unrelated tests.
const fromTest = () => {
  const lines = (new Error().stack ?? "").split("\n").slice(1)
  for (const line of lines) {
    if (line.includes("ticking-clock.mjs")) continue
    return /(?:^|[\\/])test[\\/][^\\/]+\.test\.mjs/.test(line)
  }
  return false
}
//
// Two bounds keep the shim from causing failures of its own:
//
//   - The offset wraps every 60 reads, so it never drifts more than 59s.
//     A test's fixture and expectation are read within a handful of reads of
//     each other, far inside one wrap, so they still always differ. Without
//     the wrap a full run would end ~800s ahead of real time.
//   - A read whose offset would land on another Beijing day keeps real time.
//     Fixtures are stamped with the Beijing date the suite computes at load,
//     and the plugin filters rows by the date *it* computes from real time; a
//     run that starts just before Beijing midnight would otherwise stamp
//     fixtures with tomorrow and fail a dozen tests for the shim's reason.
//     The cost is that the guard is inert for the last minute before
//     midnight — the honest trade against false reds.

const RealDate = Date
let ticks = 0

const beijingDay = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10)

const ticked = () => {
  const real = RealDate.now()
  if (!fromTest()) return real
  const at = real + ((++ticks % 60) * 1000)
  return beijingDay(at) === beijingDay(real) ? at : real
}

class TickingDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(ticked())
    else super(...args)
  }

  static now() {
    return ticked()
  }
}

globalThis.Date = TickingDate
