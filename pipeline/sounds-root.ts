import { homedir } from "node:os";
import { join } from "node:path";

/** Where the sound effects library is when Settings name no folder. */
export const defaultSoundsRoot = () => join(homedir(), "Emoton Sounds");
