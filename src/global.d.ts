import {Log} from './helpers/Log.js'
import {BetterUptime} from './integrations/BetterUptime.js'

declare global {
    var sleep: (ms: number) => Promise<unknown>
    var log: Log
    var betterUptime: BetterUptime
}

export {}