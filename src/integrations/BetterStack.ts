import _ from 'underscore'
import moment from 'moment'
import numeral from 'numeral'
import {config} from '../config.js'
import {K8sPod} from './Kubernetes.js'
import {Cron} from '../helpers/Cron.js'
import axios, {AxiosResponse} from 'axios'
import {handleError} from '../helpers/Error.js'

declare type Heartbeat = {
    id: string,
    type: string,
    attributes: {
        url: string,
        name: string,
        period: number,
        grace: number,
        call: boolean
        sms: boolean,
        email: boolean
        push: boolean,
        team_wait: boolean,
        heartbeat_group_id: string,
        sort_index: number,
        paused_at: string,
        created_at: string,
        updated_at: string,
        status: string
    }
}

declare type HeartbeatGroup = {
    id: string,
    type: string,
    attributes: {
        name: string,
        sort_index: number,
        created_at: string,
        updated_at: string,
        paused: boolean
    }
}

declare type Incident = {
    id: string,
    type: string,
    attributes: {
        name: string,
        url: string,
        cause: string,
        started_at: string,
        resolved_at: string,
        call: boolean
        sms: boolean,
        email: boolean
        push: boolean,
    }
}

export enum HeartbeatType {
    HEALTH = 'Health',
    SYNC_STATUS = 'Sync Status',
    VERSION = 'Version'
}

export enum IncidentType {
    RESTART = 'Restart',
    SLASH_POINTS = 'Slash Points',
    JAIL = 'Jail',
    CHAIN_OBSERVATION = 'Chain Observation'
}

export class BetterStack {
    private readonly apiKey: string
    private cache: Map<string, number> = new Map()

    constructor(apiKey: string) {
        this.apiKey = apiKey
    }

    async setupCleanup(schedule: string) {
        if (config.nodeENV !== 'production') return

        await log.info('Setup BetterStack incident cleanup ...')

        new Cron(schedule, async () => {
            const incidents = await global.betterStack!.getIncidents(undefined, true, false)
            const incidentsToDelete = _.sortBy(_.filter(incidents, (incident) => {
                return incident.attributes.name.includes(config.thornodeAddress.slice(-4)) // Include incidents from this node only
            }),(incident) => {
                return incident.attributes.started_at // Sort by bond (descending)
            }).reverse().slice(50)

            for (const incident of incidentsToDelete) {
                await this.deleteIncident(incident.id)
            }

            if (incidentsToDelete.length > 0) {
                await log.info(`${BetterStack.name}: Cleaned up ${incidentsToDelete.length} incidents!`)
            }
        }).run()
    }

    async initHeartbeats(name: string, types: Array<HeartbeatType>) {
        if (config.nodeENV !== 'production') return

        const existingHeartbeats = await this.getHeartbeats()

        for (const type of types) {
            const identifier = `${name} ${type} (${config.thornodeAddress.slice(-4)})`
            const exists = _.find(existingHeartbeats, (existingHeartbeat) => {
                return existingHeartbeat.attributes.name === identifier
            })

            if (!exists) {
                // Create new heartbeat
                await this.getHeartbeat(name, type)
            } else {
                await log.debug(`${BetterStack.name}: Heartbeat already created: '${identifier}'`)
            }
        }
    }

    async sendHeartbeat(name: string, type: HeartbeatType) {
        if (config.nodeENV !== 'production') return

        try {
            const heartbeat = await this.getHeartbeat(name, type)
            const response = await axios.get(heartbeat.attributes.url)

            if (response.status === 200) {
                await log.info(`Heartbeat:${heartbeat.attributes.name} ❤️`)
            } else {
                await log.error(`${BetterStack.name}:${this.sendHeartbeat.name}: HTTP status code: ${response.status}`)
            }
        } catch (error) {
            await handleError(error)
        }
    }

    async createRestartIncident(name: string, pod: K8sPod) {
        const identifier = `${name} ${IncidentType.RESTART} (${config.thornodeAddress.slice(-4)})`
        const previousRestarts = this.cache.get(identifier) ?? 0
        const lastRestartMinutesAgo = moment().diff(pod.lastRestartTime, 'minutes')

        if (pod.restarts > previousRestarts && lastRestartMinutesAgo < 10) {
            await this.createIncident(
                `${identifier}`,
                `${name} pod restarted! (reason: ${pod.restartReason}, count: ${numeral(pod.restarts).format('0,0')})`
            )
        }

        this.cache.set(identifier, pod.restarts)
    }

    async createSlashPointIncident(name: string, slashPoints: number, threshold: number) {
        const identifier = `${name} ${IncidentType.SLASH_POINTS} (${config.thornodeAddress.slice(-4)})`
        const previousSlashPoints = this.cache.get(identifier) ?? 0

        if (slashPoints > threshold && slashPoints > 2 * previousSlashPoints) {
            await this.createIncident(
                `${identifier}`,
                `${name} entered the worst performing top 10 with ${numeral(slashPoints).format('0,0')} slash points!`
            )
            this.cache.set(identifier, slashPoints)
        }
    }

    async createJailIncident(name: string, currentHeight: number, releaseHeight: number) {
        const identifier = `${name} ${IncidentType.JAIL} (${config.thornodeAddress.slice(-4)})`
        const previousReleaseHeight = this.cache.get(identifier) ?? 0

        if (currentHeight > previousReleaseHeight && releaseHeight > previousReleaseHeight) {
            const numberOfblocks = releaseHeight - currentHeight

            await this.createIncident(
                `${identifier}`,
                `${name} has been jailed until #${numeral(releaseHeight).format('0,0')} (${numeral(numberOfblocks).format('0,0')} blocks)!`
            )
            this.cache.set(identifier, releaseHeight)
        }
    }

    async createChainObservationIncident(name: string, blocksDiff: number) {
        const identifier = `${name} ${IncidentType.CHAIN_OBSERVATION} (${config.thornodeAddress.slice(-4)})`
        const previousBlocksDiff = this.cache.get(identifier) ?? 0

        if (Math.abs(blocksDiff) > Math.abs(2 * previousBlocksDiff)) {
            await this.createIncident(
                `${identifier}`,
                `${name} is ${numeral(blocksDiff).format('0,0')} block(s) ${blocksDiff < 0 ? 'behind' : 'ahead'} the majority observation of the network!`
            )
            this.cache.set(identifier, blocksDiff)
        }
    }

    private async resolveIncident(id: string) {
        await log.debug(`${BetterStack.name}: Resolving incident: ${id}`)
        await this.send('POST', `incidents/${id}/resolve`)
    }

    async resolveIncidents(name: string, type: IncidentType) {
        if (config.nodeENV !== 'production') return

        const identifier = `${name} ${type} (${config.thornodeAddress.slice(-4)})`
        const incidents = await this.getIncidents(identifier, false, false)

        for (const incident of incidents) {
            await this.resolveIncident(incident.id)
        }
    }

    private async deleteIncident(id: string) {
        await log.debug(`${BetterStack.name}: Deleting incident: ${id}`)
        await this.send('DELETE', `incidents/${id}`)
    }

    async deleteIncidents(name: string, type: IncidentType) {
        const identifier = `${name} ${type} (${config.thornodeAddress.slice(-4)})`
        let incidents = await this.getIncidents(identifier, undefined, false)

        for (const incident of incidents) {
            await this.deleteIncident(incident.id)
        }
    }

    async deleteAllIncidents() {
        const incidents = await this.getIncidents(undefined, undefined, false)

        for (const incident of incidents) {
            await this.deleteIncident(incident.id)
        }
    }

    async deleteAllHeartbeats() {
        let heartbeats = await this.getHeartbeats()

        for (const heartbeat of heartbeats) {
            await log.info(`${BetterStack.name}: Deleting heartbeat: '${heartbeat.attributes.name}'`)
            await this.send('DELETE', `heartbeats/${heartbeat.id}`)
        }
    }

    async deleteAllHeartbeatGroups() {
        const heartbeatGroups = await this.getHeartbeatGroups()

        for (const heartbeatGroup of heartbeatGroups) {
            await log.info(`${BetterStack.name}: Deleting heartbeat group: '${heartbeatGroup.attributes.name}'`)
            await this.send('DELETE', `heartbeat-groups/${heartbeatGroup.id}`)
        }
    }

    async deleteAll() {
        await this.deleteAllHeartbeats()
        await this.deleteAllHeartbeatGroups()
        await this.deleteAllIncidents()
    }

    private async getHeartbeats(): Promise<Array<Heartbeat>> {
        let response = await this.send('GET', 'heartbeats')

        let heartbeats: Array<Heartbeat> = []
        let nextPageUrl = undefined

        do {
            if (nextPageUrl) {
                response = await this.send('GET', 'heartbeats', undefined, nextPageUrl)
            }
            heartbeats = _.union(heartbeats, response.data.data)
            nextPageUrl = response.data.pagination.next
        } while (nextPageUrl)

        return heartbeats
    }

    private async getHeartbeat(name: string, type: HeartbeatType): Promise<Heartbeat> {
        const identifier = `${name} ${type} (${config.thornodeAddress.slice(-4)})`

        const heartbeats = await this.getHeartbeats()
        let heartbeat = _.first(_.filter(heartbeats, (heartbeat) => {
            return heartbeat.attributes.name === identifier
        }))

        const group = await this.getHeartbeatGroup(name)

        if (!heartbeat) {
            await log.info(`${BetterStack.name}: Creating new heartbeat: '${identifier}'`)

            // Create new heartbeat
            const response = await this.send('POST', 'heartbeats', {
                name: identifier,
                period: 60, // 1min
                grace: 300, // 5min
                heartbeat_group_id: group.id,
                email: false,
                push: true
            })
            heartbeat = response.data.data as Heartbeat
        }

        return heartbeat
    }

    private async getHeartbeatGroups(): Promise<Array<HeartbeatGroup>> {
        let response = await this.send('GET', 'heartbeat-groups')

        let heartbeatGroups: Array<HeartbeatGroup> = []
        let nextPageUrl = undefined

        do {
            if (nextPageUrl) {
                response = await this.send('GET', 'heartbeat-groups', undefined, nextPageUrl)
            }
            heartbeatGroups = _.union(heartbeatGroups, response.data.data)
            nextPageUrl = response.data.pagination.next
        } while (nextPageUrl)

        return heartbeatGroups
    }

    private async getHeartbeatGroup(name: string): Promise<HeartbeatGroup> {
        const identifier = `${name} (${config.thornodeAddress.slice(-4)})`

        const groups = await this.getHeartbeatGroups()
        let group = _.first(_.filter(groups, (group) => {
            return group.attributes.name === identifier
        }))

        if (!group) {
            await log.info(`${BetterStack.name}: Creating new heartbeat group: '${identifier}'`)

            // Create new heartbeat group
            const response = await this.send('POST', 'heartbeat-groups', {
                name: identifier
            })
            group = response.data.data as HeartbeatGroup
        }

        return group
    }

    private async createIncident(name: string, summary: string) {
        if (config.nodeENV !== 'production') return

        try {
            await this.send('POST', 'incidents', {
                requester_email: 'vordr@vordr.vordr',
                name: name,
                summary: summary,
                email: false,
                push: true
            })
        } catch (error) {
            await handleError(error)
        }
    }

    async getIncidents(title?: string, resolved?: boolean, returnEarly: boolean = true): Promise<Array<Incident>> {
        let response = await this.send('GET', 'incidents?per_page=50', {
            from: '1970-01-01',
            to: moment().format('YYYY-MM-DD')
        })

        let incidents: Array<Incident> = []
        let nextPageUrl = undefined

        do {
            await log.debug(`${BetterStack.name}:${this.getIncidents.name}: title='${title}', resolved='${resolved}', returnEarly='${returnEarly}', nextPageUrl=${nextPageUrl}`)

            if (nextPageUrl) {
                response = await this.send('GET', 'incidents?per_page=50', undefined, nextPageUrl)
            }
            incidents = _.union(incidents, _.filter(response.data.data, (incident) => {
                const isResolved = incident.attributes.resolved_at !== null
                const matchTitle = title ? incident.attributes.name === title : true
                const matchResolved = resolved !== undefined ? isResolved == resolved : true
                return matchTitle && matchResolved
            }))
            nextPageUrl = response.data.pagination.next
        } while (nextPageUrl && (returnEarly ? incidents.length === 0 : true)) // Return early if matching incidents are found

        // Sort by date
        incidents = _.sortBy(incidents, (incident) => {
            return incident.attributes.started_at
        })

        return incidents
    }

    private async send(method: string, endpoint: string, data?: object, nextPageUrl?: string): Promise<AxiosResponse> {
        let response = undefined

        while (true) {
            try {
                const url = nextPageUrl ? nextPageUrl : `https://uptime.betterstack.com/api/v2/${endpoint}`

                response = await axios.request({
                    url: url,
                    method: method,
                    data: data,
                    headers: {Authorization: `Bearer ${this.apiKey}`}
                })

                let httpCode: number
                if (endpoint.match(/^incidents\/[0-9]+\/resolve/g)) {
                    httpCode = 200
                } else if (method === 'POST') {
                    httpCode = 201
                } else if (method === 'DELETE') {
                    httpCode = 204
                } else {
                    httpCode = 200
                }

                if (response.status === httpCode) {
                    break
                } else {
                    await log.error(`${BetterStack.name}:${this.send.name}: HTTP status code: ${response.status}`)
                }
            } catch (error) {
                await sleep(100)
            }
        }

        return response
    }
}
