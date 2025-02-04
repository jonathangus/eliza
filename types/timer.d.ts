declare module "timers" {
    interface Timeout {
        [Symbol.dispose]?: () => void;
    }
}
