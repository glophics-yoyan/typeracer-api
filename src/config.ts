import 'dotenv/config';

export interface AppConfig {
    port: number;
    allowed_origins: string[];
}

function parsePort(value: string | undefined): number {
    const port = Number(value ?? 8080);

    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error('PORT must be an integer between 0 and 65535');
    }

    return port;
}

function parseOrigins(value: string | undefined): string[] {
    return (value ?? 'http://localhost:3000')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}

export function getConfig(): AppConfig {
    return {
        port: parsePort(process.env.PORT),
        allowed_origins: parseOrigins(process.env.ALLOWED_ORIGINS),
    };
}
