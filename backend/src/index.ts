import { Elysia } from 'elysia';
import { swagger } from '@elysiajs/swagger';
import { cors } from '@elysiajs/cors';
import { loadConfig } from './core/config';
import { JsonStore } from './core/storage';

const config = loadConfig();
const store = new JsonStore(config.data_path);

const app = new Elysia()
    .use(swagger({
        path: '/swagger',
        documentation: {
            info: {
                title: 'AI Delivery Ops Agent API',
                version: '1.0.0'
            }
        }
    }))
    .use(cors())
    .get('/', () => 'Delivery Ops Bridge (TypeScript) is running')
    .get('/api/config', () => {
        return config;
    })
    .get('/api/health', () => ({ status: 'ok' }))
    .listen(8091);

console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
console.log(`Loaded config for project: ${config.project.name}`);
console.log(`Data path: ${config.data_path}`);
