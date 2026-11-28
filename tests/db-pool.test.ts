import { describe, expect, it, vi } from 'vitest';
import { baseEnvSchema } from '@talkie/core';
import { connectDatabase } from '@talkie/db';

describe('shared database pool', () => {
  it('reuses connections until the last service closes', async () => {
    const env = { ...baseEnvSchema.parse({ DB_SHARED_NAME: 'pool_test', DB_POOL_SHARED: 'true', DB_POOL_SIZE: '4' }), WORKER_ID: 1 };
    const chat = connectDatabase(env, 'talkie_chat');
    const users = connectDatabase(env, 'talkie_users');
    const end = vi.spyOn(chat.pool, 'end');
    expect(users.pool).toBe(chat.pool);
    await chat.close();
    await chat.close();
    expect(end).not.toHaveBeenCalled();
    await users.close();
    expect(end).toHaveBeenCalledTimes(1);
    const next = connectDatabase(env, 'talkie_users');
    expect(next.pool).not.toBe(chat.pool);
    await next.close();
  });
});
