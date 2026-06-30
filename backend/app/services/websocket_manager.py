"""Manages active WebSocket connections for teacher dashboards."""
import json
from collections import defaultdict

from fastapi import WebSocket


class ConnectionManager:
    def __init__(self):
        # Maps class_id → list of connected teacher WebSockets
        self._connections: dict[int, list[WebSocket]] = defaultdict(list)

    async def connect(self, websocket: WebSocket, class_id: int):
        await websocket.accept()
        self._connections[class_id].append(websocket)

    def disconnect(self, websocket: WebSocket, class_id: int):
        conns = self._connections.get(class_id, [])
        if websocket in conns:
            conns.remove(websocket)

    async def broadcast(self, class_id: int, message: dict):
        """Send a JSON message to all teachers watching this class."""
        dead = []
        for ws in self._connections.get(class_id, []):
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, class_id)


manager = ConnectionManager()
