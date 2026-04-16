// Shared in-memory session state used across read and edit modules.
// Kept separate to avoid circular imports between story/read.js and story/edit.js.

export const pendingReadData = new Map(); // userId -> read session
export const lastReadPage = new Map();    // `${userId}_${storyId}` -> pageIndex
export const pendingEditData = new Map(); // userId -> edit session
