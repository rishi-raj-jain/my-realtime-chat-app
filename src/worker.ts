import { handle } from '@astrojs/cloudflare/handler';
import type { SSRManifest } from 'astro';
import { App } from 'astro/app';
import { DurableObject } from 'cloudflare:workers';

interface WebSocketSession {
    webSocket: WebSocket
    userId: string
    username: string
    quit?: boolean
}

interface ChatMessage {
    id: string
    type: 'message' | 'join' | 'leave' | 'presence'
    userId: string
    username: string
    content?: string
    timestamp: number
}

class ChatRoom extends DurableObject<ENV> {
    private sessions: Set<WebSocketSession>
    private messageHistory: ChatMessage[]

    constructor(ctx: DurableObjectState, env: ENV) {
        super(ctx, env)

        this.sessions = new Set()
        this.messageHistory = []

        // Load message history from storage on initialization
        this.ctx.blockConcurrencyWhile(async () => {
            const stored = await this.ctx.storage.get<ChatMessage[]>('messages')
            if (stored) this.messageHistory = stored
        })
    }

    /**
     * Handle HTTP requests to this Durable Object
     * This is called when a client wants to establish a WebSocket connection
     */
    async fetch(request: Request): Promise<Response> {
        // Parse the URL to get query parameters (userId and username)
        const url = new URL(request.url)
        const userId = url.searchParams.get('userId')
        const username = url.searchParams.get('username')
        if (!userId || !username)
            return new Response('Missing userId or username', { status: 400 })
        // Expect a WebSocket upgrade request
        const upgradeHeader = request.headers.get('Upgrade')
        if (upgradeHeader !== 'websocket')
            return new Response('Expected WebSocket upgrade', { status: 426 })
        // Create a WebSocket pair (client and server)
        const pair = new WebSocketPair()
        const [client, server] = Object.values(pair)
        // Accept the WebSocket connection
        server.accept()
        // Create a session for this connection
        const session: WebSocketSession = {
            webSocket: server,
            userId,
            username,
        }
        // Add to active sessions
        this.sessions.add(session)
        // Set up event handlers for this WebSocket
        server.addEventListener('message', (event) => {
            this.handleMessage(session, event.data as string)
        })
        server.addEventListener('close', () => {
            this.handleClose(session)
        })
        server.addEventListener('error', () => {
            this.handleClose(session)
        })
        // Send message history to the newly connected client
        this.sendMessageHistory(session)
        // Broadcast join notification to all clients
        this.broadcast({
            id: crypto.randomUUID(),
            type: 'join',
            userId,
            username,
            timestamp: Date.now(),
        })
        // Send current presence to the new user
        this.sendPresence(session)
        // Return the client WebSocket in the response
        return new Response(null, {
            status: 101,
            webSocket: client,
        })
    }

    /**
     * Handle incoming WebSocket messages
     */
    private handleMessage(session: WebSocketSession, data: string): void {
        try {
            const parsed = JSON.parse(data)
            if (parsed.type === 'message' && parsed.content) {
                // Create a chat message
                const message: ChatMessage = {
                    id: crypto.randomUUID(),
                    type: 'message',
                    userId: session.userId,
                    username: session.username,
                    content: parsed.content,
                    timestamp: Date.now(),
                }
                // Add to history
                this.messageHistory.push(message)
                // Persist to storage (limit to last 100 messages)
                if (this.messageHistory.length > 100)
                    this.messageHistory = this.messageHistory.slice(-100)
                this.ctx.storage.put('messages', this.messageHistory)
                // Broadcast to all connected clients
                this.broadcast(message)
            }
        } catch (error) {
            console.error('Error handling message:', error)
        }
    }

    /**
     * Handle WebSocket close events
     */
    private handleClose(session: WebSocketSession): void {
        // Remove from sessions
        this.sessions.delete(session)
        // Broadcast leave notification if not already quit
        if (!session.quit) {
            this.broadcast({
                id: crypto.randomUUID(),
                type: 'leave',
                userId: session.userId,
                username: session.username,
                timestamp: Date.now(),
            })
        }
        // Close the WebSocket if not already closed
        try {
            session.webSocket.close()
        } catch (error) {
            // Already closed
        }
    }

    /**
     * Broadcast a message to all connected clients
     */
    private broadcast(message: ChatMessage): void {
        const messageStr = JSON.stringify(message)

        // Send to all active sessions
        this.sessions.forEach((session) => {
            try {
                session.webSocket.send(messageStr)
            } catch (error) {
                // Connection might be closed, will be cleaned up by close handler
                console.error('Error broadcasting to session:', error)
            }
        })
    }

    /**
     * Send message history to a specific session
     */
    private sendMessageHistory(session: WebSocketSession): void {
        const historyMessage = JSON.stringify({
            type: 'history',
            messages: this.messageHistory,
        })
        try {
            session.webSocket.send(historyMessage)
        } catch (error) {
            console.error('Error sending history:', error)
        }
    }

    /**
     * Send current user presence to a specific session
     */
    private sendPresence(session: WebSocketSession): void {
        const users = Array.from(this.sessions).map((s) => ({
            userId: s.userId,
            username: s.username,
        }))
        const presenceMessage = JSON.stringify({
            type: 'presence',
            users,
        })
        try {
            session.webSocket.send(presenceMessage)
        } catch (error) {
            console.error('Error sending presence:', error)
        }
    }

    /**
     * Optional: Handle Durable Object alarm for cleanup tasks
     */
    async alarm(): Promise<void> {
        // Clean up old messages (older than 24 hours)
        const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
        this.messageHistory = this.messageHistory.filter((msg) => msg.timestamp > oneDayAgo)
        await this.ctx.storage.put('messages', this.messageHistory)
        // Schedule next cleanup in 1 hour
        await this.ctx.storage.setAlarm(Date.now() + 60 * 60 * 1000)
    }
}

export function createExports(manifest: SSRManifest) {
    const app = new App(manifest);
    return {
        default: {
            async fetch(request, env, ctx) {
                // @ts-expect-error - request is not typed correctly
                return handle(manifest, app, request, env, ctx);
            }
        } satisfies ExportedHandler<ENV>,
        ChatRoom,
    }
}
