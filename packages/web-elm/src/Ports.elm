port module Ports exposing (..)

import Json.Decode exposing (Value)


{-| Opens the one live stream of this window on `url`, closing any other.
-}
port streamOpen : String -> Cmd msg


port streamClose : () -> Cmd msg


{-| A frame: `{url, transcript}`.
-}
port streamFrame : (Value -> msg) -> Sub msg


{-| `{url, state}`: "open", "lost" (retrying) or "ended: <why>".
-}
port streamState : (Value -> msg) -> Sub msg


{-| The run ends this browser has shown, kept in localStorage.
-}
port saveSeen : Value -> Cmd msg


{-| Another window saved them.
-}
port seenChanged : (Value -> msg) -> Sub msg


{-| The selection in the open artifact, as an anchor, or null.
-}
port selectionMade : (Value -> msg) -> Sub msg
