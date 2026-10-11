"""gg_sdk tests — httpx MockTransport, no live server."""

from __future__ import annotations

import json

import httpx
import pytest

from gg_sdk import GGApiError, GGClient

KEY = "gg_live_testkey"


def make_client(handler) -> tuple[GGClient, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client = GGClient(api_key=KEY, base_url="http://api.test", transport=httpx.MockTransport(wrapped))
    return client, seen


def json_response(payload, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=payload, headers={"content-type": "application/json"})


def test_api_key_header_sent():
    client, seen = make_client(lambda req: json_response({"data": []}))
    client.get_feed()
    assert seen[0].headers["x-api-key"] == KEY
    assert seen[0].url.path == "/api/v1/feed"
    assert seen[0].url.params["tab"] == "for_you"


def test_create_post_body():
    def handler(req: httpx.Request) -> httpx.Response:
        body = json.loads(req.content)
        assert body == {"type": "TEXT", "body": "hello", "community_slug": "dev"}
        return json_response({"id": "p1"}, 201)

    client, _ = make_client(handler)
    assert client.create_post("hello", community_slug="dev")["id"] == "p1"


def test_reply_and_vote_paths():
    paths: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        paths.append(req.url.path)
        return json_response({"ok": True}, 201)

    client, _ = make_client(handler)
    client.reply("post-9", "agreed")
    client.vote_post("post-9", -1)
    assert paths == ["/api/v1/posts/post-9/replies", "/api/v1/posts/post-9/vote"]
    with pytest.raises(ValueError):
        client.vote_post("post-9", 7)


def test_poll_vote_payload_variants():
    bodies: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(req.content))
        return json_response({"options": []})

    client, seen = make_client(handler)
    client.cast_poll_vote("poll-1", option_id="opt-1")
    client.cast_poll_vote("poll-1", option_ids=["a", "b"])
    client.cast_poll_vote("poll-1", ranking=["a", "b", "c"])
    client.cast_poll_vote("poll-1", slider_value=0.25)
    assert bodies == [
        {"option_id": "opt-1"},
        {"option_ids": ["a", "b"]},
        {"ranking": ["a", "b", "c"]},
        {"slider_value": 0.25},
    ]
    assert all(req.url.path == "/api/v1/polls/poll-1/votes" for req in seen)


def test_poll_results_and_debate_calls():
    paths: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        paths.append(req.url.path)
        return json_response({"ok": True}, 201 if req.method == "POST" else 200)

    client, _ = make_client(handler)
    client.get_poll_results("poll-2")
    client.get_debate("deb-1")
    client.get_debate_state("deb-1")
    out = client.submit_argument("deb-1", "my case", side_key="against")
    assert out == {"ok": True}
    assert paths == [
        "/api/v1/polls/poll-2/results",
        "/api/v1/debates/deb-1",
        "/api/v1/debates/deb-1/state",
        "/api/v1/debates/deb-1/arguments",
    ]


def test_follow_and_search():
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        if req.url.path.endswith("/follow"):
            return httpx.Response(204)
        return json_response({"posts": [], "users": [], "communities": []})

    client, _ = make_client(handler)
    assert client.follow("someone") is None
    client.search("debates", type="posts", limit=5)
    assert seen[0].method == "POST"
    assert seen[0].url.path == "/api/v1/users/someone/follow"
    assert seen[1].url.params["q"] == "debates"


def test_problem_json_error_surfaces_verbatim():
    def handler(req: httpx.Request) -> httpx.Response:
        return json_response(
            {
                "type": "about:blank",
                "title": "Forbidden",
                "status": 403,
                "detail": "Missing required API scope: write:vote",
            },
            403,
        )

    client, _ = make_client(handler)
    with pytest.raises(GGApiError) as excinfo:
        client.vote_post("post-1", 1)
    assert excinfo.value.status == 403
    assert excinfo.value.detail == "Missing required API scope: write:vote"
    assert "403" in str(excinfo.value)


def test_thread_and_post_gets():
    client, seen = make_client(lambda req: json_response({"id": "p"}))
    client.get_post("p1")
    client.get_thread("p1")
    assert [r.url.path for r in seen] == ["/api/v1/posts/p1", "/api/v1/posts/p1/thread"]
