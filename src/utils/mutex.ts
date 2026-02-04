/**
 * Simple Mutex for serializing async operations
 */
export class Mutex {
    private mutex = Promise.resolve();

    lock(): Promise<() => void> {
        let begin: (unlock: () => void) => void = () => { };

        this.mutex = this.mutex.then(() => {
            return new Promise(resolve => {
                begin = resolve as any;
            });
        });

        return new Promise(resolve => {
            resolve(begin as any);
        });
    }

    async dispatch<T>(fn: (() => T) | (() => PromiseLike<T>)): Promise<T> {
        const unlock = await this.lock();
        try {
            return await Promise.resolve(fn());
        } finally {
            unlock();
        }
    }
}
