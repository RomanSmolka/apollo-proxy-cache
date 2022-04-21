export interface Cache<K, V = null | Record<string, any>> {
  delete(key: K): Promise<boolean>
  get(key: K): Promise<V>
  hget(key: K): Promise<any>
  set(key: K, value: V, timeout: number): Promise<Cache<K, V>>
  hset(key: K, field: K, value: string, timeout: number): Promise<Cache<K, V>>
}
