module Data exposing (..)

{-| What cubed's API says, as Elm data, and the requests that read it.
-}

import Dict exposing (Dict)
import Http
import Json.Decode as D exposing (Decoder)
import Json.Encode as E



-- HTTP


{-| A failed exchange. `status` 0: the request never reached cubed.
-}
type alias ApiError =
    { status : Int, message : String }


type alias Api a =
    Result ApiError a


expect : (Api a -> msg) -> Decoder a -> Http.Expect msg
expect toMsg decoder =
    Http.expectStringResponse toMsg <|
        \response ->
            case response of
                Http.BadUrl_ url ->
                    Err (ApiError 0 ("bad url " ++ url))

                Http.Timeout_ ->
                    Err (ApiError 0 "cubed did not answer in time")

                Http.NetworkError_ ->
                    Err (ApiError 0 "can't reach cubed: it may be starting or restarting")

                Http.BadStatus_ meta body ->
                    Err
                        (ApiError meta.statusCode
                            (D.decodeString (D.field "error" D.string) body
                                |> Result.withDefault ("cubed answered " ++ String.fromInt meta.statusCode)
                            )
                        )

                Http.GoodStatus_ _ body ->
                    D.decodeString decoder body
                        |> Result.mapError (\error -> ApiError -1 ("unreadable answer: " ++ D.errorToString error))


get : String -> Decoder a -> (Api a -> msg) -> Cmd msg
get url decoder toMsg =
    Http.request { method = "GET", headers = [], url = url, body = Http.emptyBody, expect = expect toMsg decoder, timeout = Just 20000, tracker = Nothing }


send : String -> String -> E.Value -> Decoder a -> (Api a -> msg) -> Cmd msg
send method url body decoder toMsg =
    Http.request { method = method, headers = [], url = url, body = Http.jsonBody body, expect = expect toMsg decoder, timeout = Just 60000, tracker = Nothing }


andMap : Decoder a -> Decoder (a -> b) -> Decoder b
andMap =
    D.map2 (|>)


{-| A field that may be absent or null.
-}
opt : String -> Decoder a -> Decoder (Maybe a)
opt name decoder =
    D.oneOf [ D.field name (D.nullable decoder), D.succeed Nothing ]


optAt : List String -> Decoder a -> Decoder (Maybe a)
optAt path decoder =
    D.oneOf [ D.at path (D.nullable decoder), D.succeed Nothing ]


withDefault : a -> Decoder (Maybe a) -> Decoder a
withDefault fallback =
    D.map (Maybe.withDefault fallback)



-- MODELS


type alias ModelRef =
    { provider : String, id : String }


modelRef : Decoder ModelRef
modelRef =
    D.map2 ModelRef (D.field "provider" D.string) (D.field "id" D.string)


modelName : ModelRef -> String
modelName model =
    model.provider ++ "/" ++ model.id


encodeModel : ModelRef -> E.Value
encodeModel model =
    E.object [ ( "provider", E.string model.provider ), ( "id", E.string model.id ) ]


type alias Models =
    { models : List ModelRef, selected : Maybe ModelRef }


models : Decoder Models
models =
    D.map2 Models (D.field "models" (D.list modelRef)) (opt "selected" modelRef)



-- THREADS


type Machine
    = MachineStarting
    | MachineReady
    | MachineError


type Sleep
    = Suspended Int
    | Waking (Maybe String)
    | Queued String Int


type alias Step =
    { name : String, attempt : Maybe Int, state : String, startedAt : Int, endedAt : Maybe Int, detail : Maybe String, log : Maybe String }


type alias Thread =
    { id : String
    , title : Maybe String
    , name : Maybe String
    , projectId : String
    , projectName : String
    , machine : Machine
    , error : Maybe String
    , failureKind : Maybe String
    , waiting : Maybe String
    , createdAt : Int
    , archived : Bool
    , agent : String
    , model : Maybe ModelRef
    , runnerId : Maybe String
    , vmId : Maybe String
    , steps : List Step
    , sleep : Maybe Sleep
    , notice : Maybe String
    , retain : Maybe Bool
    , retainReason : Maybe String
    , discarded : Bool
    , startupMs : Maybe Int
    , prepared : Maybe String
    }


threadLabel : Thread -> String
threadLabel item =
    case ( item.title, item.name ) of
        ( Just title, _ ) ->
            title

        ( Nothing, Just name ) ->
            name

        _ ->
            "untitled thread"


shortId : String -> String
shortId =
    String.left 8


step : Decoder Step
step =
    D.map7 Step
        (D.field "name" D.string)
        (opt "attempt" D.int)
        (D.field "state" D.string)
        (D.field "startedAt" D.int)
        (opt "endedAt" D.int)
        (opt "detail" D.string)
        (opt "log" D.string)


sleep : Decoder Sleep
sleep =
    D.field "state" D.string
        |> D.andThen
            (\state ->
                case state of
                    "suspended" ->
                        D.map Suspended (D.field "at" D.int)

                    "waking" ->
                        D.map Waking (opt "waiting" D.string)

                    "queued" ->
                        D.map2 Queued (D.field "waiting" D.string) (D.field "since" D.int)

                    other ->
                        D.fail ("unknown sleep state " ++ other)
            )


thread : Decoder Thread
thread =
    D.succeed Thread
        |> andMap (D.field "id" D.string)
        |> andMap (opt "title" D.string)
        |> andMap (opt "name" (D.map2 (\emoji words -> emoji ++ " " ++ words) (D.field "emoji" D.string) (D.field "words" D.string)))
        |> andMap (D.at [ "project", "id" ] D.string)
        |> andMap (D.at [ "project", "name" ] D.string)
        |> andMap
            (D.field "state" D.string
                |> D.map
                    (\state ->
                        case state of
                            "starting" ->
                                MachineStarting

                            "error" ->
                                MachineError

                            _ ->
                                MachineReady
                    )
            )
        |> andMap (opt "error" D.string)
        |> andMap (opt "failureKind" D.string)
        |> andMap (opt "waiting" D.string)
        |> andMap (opt "createdAt" D.int |> withDefault 0)
        |> andMap (D.field "archived" D.bool)
        |> andMap (opt "agent" D.string |> withDefault "pi")
        |> andMap (opt "model" modelRef)
        |> andMap (opt "runnerId" D.string)
        |> andMap (optAt [ "vm", "vmId" ] D.string)
        |> andMap (optAt [ "vm", "steps" ] (D.list step) |> withDefault [])
        |> andMap (optAt [ "vm", "suspension" ] sleep)
        |> andMap (optAt [ "vm", "notice", "text" ] D.string)
        |> andMap (optAt [ "vm", "retain" ] D.bool)
        |> andMap (optAt [ "vm", "retainReason" ] D.string)
        |> andMap (optAt [ "vm", "discarded" ] D.bool |> withDefault False)
        |> andMap (optAt [ "vm", "startup", "totalMs" ] D.int)
        |> andMap (D.oneOf [ D.at [ "vm", "preparation", "source" ] D.string |> D.map Just, optAt [ "vm", "startup", "source" ] D.string ])



-- TRANSCRIPTS


type RunState
    = Idle
    | Working
    | Completed
    | Failed
    | Stopped


type alias RunStatus =
    { state : RunState, run : Maybe String, error : Maybe String, waiting : List String }


type Event
    = UserMessage { id : String, text : String, from : Maybe String }
    | AssistantText { id : String, text : String, reasoning : Bool, final : Bool }
    | ToolCall { id : String, callId : String, name : String, input : D.Value, final : Bool }
    | ToolResult { id : String, callId : String, name : String, output : String, isError : Bool, final : Bool }


type alias Transcript =
    { status : RunStatus, events : List Event, start : Int, agent : String }


runStatus : Decoder RunStatus
runStatus =
    D.map4 RunStatus
        (D.field "state" D.string
            |> D.map
                (\state ->
                    case state of
                        "working" ->
                            Working

                        "completed" ->
                            Completed

                        "failed" ->
                            Failed

                        "stopped" ->
                            Stopped

                        _ ->
                            Idle
                )
        )
        (opt "run" D.string)
        (opt "error" D.string)
        (opt "waiting" (D.list D.string) |> withDefault [])


event : Decoder Event
event =
    D.field "type" D.string
        |> D.andThen
            (\kind ->
                case kind of
                    "user-message" ->
                        D.map3 (\id text from -> UserMessage { id = id, text = text, from = from })
                            (D.field "id" D.string)
                            (D.field "text" D.string)
                            (opt "from" D.string)

                    "assistant-text" ->
                        D.map4 (\id text reasoning final -> AssistantText { id = id, text = text, reasoning = reasoning, final = final })
                            (D.field "id" D.string)
                            (D.field "text" D.string)
                            (D.field "reasoning" D.bool)
                            (D.field "final" D.bool)

                    "tool-call" ->
                        D.map5 (\id callId name input final -> ToolCall { id = id, callId = callId, name = name, input = input, final = final })
                            (D.field "id" D.string)
                            (D.field "callId" D.string)
                            (D.field "name" D.string)
                            (D.oneOf [ D.field "input" D.value, D.succeed E.null ])
                            (D.field "final" D.bool)

                    "tool-result" ->
                        D.map6 (\id callId name output isError final -> ToolResult { id = id, callId = callId, name = name, output = output, isError = isError, final = final })
                            (D.field "id" D.string)
                            (D.field "callId" D.string)
                            (D.field "name" D.string)
                            (D.field "output" D.string)
                            (D.field "isError" D.bool)
                            (D.field "final" D.bool)

                    other ->
                        D.fail ("unknown event type " ++ other)
            )


transcript : Decoder Transcript
transcript =
    D.map4 Transcript
        (D.field "status" runStatus)
        (D.field "events" (D.list event))
        (opt "start" D.int |> withDefault 0)
        (opt "agent" D.string |> withDefault "pi")


type alias Page =
    { start : Int, events : List Event }


page : Decoder Page
page =
    D.map2 Page (D.field "start" D.int) (D.field "events" (D.list event))


{-| One thread's run as `GET /api/activity` reads it (the preview host's
route; cubed has none): `status` Nothing when the agent never stored a run.
-}
type alias Activity =
    { id : String, agentOpen : Bool, status : Maybe RunStatus, events : List Event, error : Maybe String }


activity : Decoder (Dict String Activity)
activity =
    D.field "threads"
        (D.list
            (D.map5 Activity
                (D.field "id" D.string)
                (D.field "agentOpen" D.bool)
                (opt "status" runStatus)
                (D.field "events" (D.list event))
                (opt "error" D.string)
            )
        )
        |> D.map (List.map (\item -> ( item.id, item )) >> Dict.fromList)


{-| The run states `GET /api/optchat/threads` gives for the threads OptChat
started: the fallback where `/api/activity` does not exist.
-}
overview : Decoder (Dict String String)
overview =
    D.field "threads" (D.list (D.map2 Tuple.pair (D.field "id" D.string) (D.field "state" D.string)))
        |> D.map Dict.fromList



-- PROJECTS


type alias Repository =
    { url : String, base : Maybe String, status : String, error : Maybe String, resolvedBase : Maybe String, baseOid : Maybe String }


type alias Project =
    { id : String
    , name : String
    , status : String
    , error : Maybe String
    , repositories : List Repository
    , threadCount : Int
    , preSetup : String
    , preResume : String
    , vcpus : Maybe Int
    , memoryMiB : Maybe Int
    }


project : Decoder Project
project =
    D.succeed Project
        |> andMap (D.field "id" D.string)
        |> andMap (D.field "name" D.string)
        |> andMap (D.field "status" D.string)
        |> andMap (opt "error" D.string)
        |> andMap
            (D.field "repositories"
                (D.list
                    (D.map6 Repository
                        (D.field "url" D.string)
                        (opt "base" D.string)
                        (D.field "status" D.string)
                        (opt "error" D.string)
                        (opt "resolvedBase" D.string)
                        (opt "baseOid" D.string)
                    )
                )
            )
        |> andMap (opt "threadCount" D.int |> withDefault 0)
        |> andMap (optAt [ "hooks", "preSetup" ] D.string |> withDefault "")
        |> andMap (optAt [ "hooks", "preResume" ] D.string |> withDefault "")
        |> andMap (optAt [ "machineDefaults", "vcpus" ] D.int)
        |> andMap (optAt [ "machineDefaults", "memoryMiB" ] D.int)



-- RUNNERS


type alias Report =
    { ageMs : Int, fresh : Bool, version : String, lifecycle : String, draining : Bool, activeVms : Int, runningVms : Int, retainedVms : Int, platform : Maybe String }


type alias Runner =
    { id : String
    , nodeId : String
    , kind : String
    , protocol : Int
    , byName : Bool
    , contact : String
    , lastContactAt : Maybe Int
    , unreachableSince : Maybe Int
    , contactError : Maybe String
    , report : Maybe Report
    , slotsTotal : Int
    , slotsReserved : Int
    , slotsFree : Int
    , allocatable : Bool
    , retirement : String
    , unknown : List String
    }


type alias RunnerPool =
    { observedAt : Int, slots : Int, reserved : Int, free : Int, runners : List Runner, notReported : List String }


runner : Decoder Runner
runner =
    D.succeed Runner
        |> andMap (D.field "id" D.string)
        |> andMap (D.field "nodeId" D.string)
        |> andMap (D.field "kind" D.string)
        |> andMap (D.field "protocol" D.int)
        |> andMap (D.field "byName" D.bool)
        |> andMap (D.at [ "contact", "status" ] D.string)
        |> andMap (optAt [ "contact", "lastContactAt" ] D.int)
        |> andMap (optAt [ "contact", "unreachableSince" ] D.int)
        |> andMap (optAt [ "contact", "error" ] D.string)
        |> andMap
            (opt "report"
                (D.succeed Report
                    |> andMap (D.field "ageMs" D.int)
                    |> andMap (D.field "fresh" D.bool)
                    |> andMap (D.field "softwareVersion" D.string)
                    |> andMap (D.field "lifecycle" D.string)
                    |> andMap (D.field "draining" D.bool)
                    |> andMap (D.field "activeVms" D.int)
                    |> andMap (D.field "runningVms" D.int)
                    |> andMap (D.field "retainedVms" D.int)
                    |> andMap (opt "platform" D.string)
                )
            )
        |> andMap (D.at [ "slots", "total" ] D.int)
        |> andMap (D.at [ "slots", "reserved" ] D.int)
        |> andMap (D.at [ "slots", "free" ] D.int)
        |> andMap (D.at [ "slots", "allocatable" ] D.bool)
        |> andMap (D.field "retirement" D.string)
        |> andMap (opt "unknown" (D.list D.string) |> withDefault [])


runners : Decoder RunnerPool
runners =
    D.map6 RunnerPool
        (D.field "observedAt" D.int)
        (D.at [ "pool", "slots" ] D.int)
        (D.at [ "pool", "reserved" ] D.int)
        (D.at [ "pool", "free" ] D.int)
        (D.field "runners" (D.list runner))
        (opt "notReported" (D.list D.string) |> withDefault [])



-- ARTIFACTS


type alias CommentCounts =
    { draft : Int, queued : Int, delivered : Int, undeliverable : Int }


type alias ArtifactItem =
    { id : String
    , title : String
    , head : Int
    , updatedAt : Int
    , projectId : Maybe String
    , projectName : Maybe String
    , threadId : Maybe String
    , threadTitle : Maybe String
    , authorKind : String
    , comments : CommentCounts
    }


artifactItem : Decoder ArtifactItem
artifactItem =
    D.succeed ArtifactItem
        |> andMap (D.field "id" D.string)
        |> andMap (D.field "title" D.string)
        |> andMap (D.field "head" D.int)
        |> andMap (D.field "updatedAt" D.int)
        |> andMap (optAt [ "project", "id" ] D.string)
        |> andMap (optAt [ "project", "name" ] D.string)
        |> andMap (optAt [ "thread", "id" ] D.string)
        |> andMap (optAt [ "thread", "title" ] D.string)
        |> andMap (D.at [ "author", "kind" ] D.string)
        |> andMap
            (D.field "comments"
                (D.map4 CommentCounts (D.field "draft" D.int) (D.field "queued" D.int) (D.field "delivered" D.int) (D.field "undeliverable" D.int))
            )


type alias Anchor =
    { quote : String, prefix : String, suffix : String, start : Int, end : Int, section : String }


anchor : Decoder Anchor
anchor =
    D.map6 Anchor (D.field "quote" D.string) (D.field "prefix" D.string) (D.field "suffix" D.string) (D.field "start" D.int) (D.field "end" D.int) (D.field "section" D.string)


encodeAnchor : Anchor -> E.Value
encodeAnchor a =
    E.object [ ( "quote", E.string a.quote ), ( "prefix", E.string a.prefix ), ( "suffix", E.string a.suffix ), ( "start", E.int a.start ), ( "end", E.int a.end ), ( "section", E.string a.section ) ]


type alias Comment =
    { id : String, revision : Int, anchor : Anchor, body : String, state : String, note : Maybe String }


comment : Decoder Comment
comment =
    D.map6 Comment (D.field "id" D.string) (D.field "revision" D.int) (D.field "anchor" anchor) (D.field "body" D.string) (D.field "state" D.string) (opt "note" D.string)


type alias RevisionInfo =
    { number : Int, title : String, createdAt : Int, actions : Int }


type alias ActionRun =
    { action : String, revision : Int, state : String, detail : String }


type alias ArtifactView =
    { item : ArtifactItem, revisions : List RevisionInfo, comments : List Comment, runs : List ActionRun }


artifactView : Decoder ArtifactView
artifactView =
    D.map4 ArtifactView
        (D.field "artifact" artifactItem)
        (D.field "revisions" (D.list (D.map4 RevisionInfo (D.field "number" D.int) (D.field "title" D.string) (D.field "createdAt" D.int) (D.field "actions" D.int))))
        (D.field "comments" (D.list comment))
        (D.field "actionRuns" (D.list (D.map4 ActionRun (D.field "action" D.string) (D.field "revision" D.int) (D.field "state" D.string) (D.field "detail" D.string))))


type alias Action =
    { id : String, kind : String, label : String, repository : String, pull : Int, headSha : String, method : String }


action : Decoder Action
action =
    D.map7 Action (D.field "id" D.string) (D.field "kind" D.string) (D.field "label" D.string) (D.field "repository" D.string) (D.field "pull" D.int) (D.field "headSha" D.string) (D.field "method" D.string)


type alias Revision =
    { number : Int, title : String, body : String, actions : List Action }


revision : Decoder Revision
revision =
    D.field "revision" (D.map4 Revision (D.field "number" D.int) (D.field "title" D.string) (D.field "body" D.string) (D.field "actions" (D.list action)))


type alias Preview =
    { confirm : String, problems : List String, pullTitle : Maybe String, pullState : Maybe String, pullUrl : Maybe String }


preview : Decoder Preview
preview =
    D.field "preview"
        (D.map5 Preview
            (D.field "confirm" D.string)
            (D.field "problems" (D.list D.string))
            (optAt [ "pull", "title" ] D.string)
            (optAt [ "pull", "state" ] D.string)
            (optAt [ "pull", "url" ] D.string)
        )



-- THREAD DETAILS


type alias Service =
    { name : String, portNumber : Int, url : Maybe String, state : Maybe String }


type alias Services =
    { portal : String, running : Bool, services : List Service }


services : Decoder Services
services =
    D.map3 Services
        (D.field "portal" (D.oneOf [ D.string, D.field "state" D.string, D.succeed "unknown" ]))
        (D.field "running" D.bool)
        (D.field "services" (D.list (D.map4 Service (D.field "name" D.string) (D.field "port" D.int) (opt "url" D.string) (opt "state" D.string))))


type alias Spend =
    { tokens : Int, usd : Maybe Float }


spend : Decoder Spend
spend =
    D.map2 Spend (D.at [ "tokens", "total" ] D.int) (opt "estimatedUsd" D.float)


threadUsage : Decoder Spend
threadUsage =
    D.at [ "usage", "lines" ] (D.list (D.field "spend" spend))
        |> D.map (\lines -> Spend (List.sum (List.map .tokens lines)) (Just (List.sum (List.filterMap .usd lines))))



-- HOST


type alias Health =
    { lifecycle : String, version : String, commit : String, gateway : String, portal : String, preview : Maybe String }


health : Decoder Health
health =
    D.map6 Health
        (D.field "lifecycle" D.string)
        (D.field "version" D.string)
        (opt "commit" D.string |> withDefault "unknown")
        (opt "gateway" D.string |> withDefault "unknown")
        (D.oneOf [ D.field "portal" D.string, D.at [ "portal", "state" ] D.string, D.succeed "unknown" ])
        (opt "preview" D.string)


type alias Provider =
    { id : String, name : String, connected : Bool, kind : String, checkError : Bool }


providers : Decoder (List Provider)
providers =
    D.field "providers"
        (D.list
            (D.map5 Provider (D.field "id" D.string) (D.field "name" D.string) (D.field "connected" D.bool) (opt "type" D.string |> withDefault "") (opt "checkError" D.bool |> withDefault False))
        )


type alias UsageReport =
    { total : Spend, coverage : String, note : Maybe String, projects : List ( String, Spend ) }


usageReport : Decoder UsageReport
usageReport =
    D.map4 UsageReport
        (D.at [ "totals", "spend" ] spend)
        (D.at [ "totals", "coverage" ] D.string)
        (optAt [ "billed", "note" ] D.string)
        (D.field "projects" (D.list (D.map2 Tuple.pair (D.field "name" D.string) (D.at [ "totals", "spend" ] spend))))


type alias Update =
    { installation : String, version : String, phase : String, available : Maybe String, message : Maybe String, error : Maybe String }


update : Decoder Update
update =
    D.map6 Update
        (D.field "installation" D.string)
        (D.at [ "current", "version" ] D.string)
        (D.field "phase" D.string)
        (optAt [ "available", "version" ] D.string)
        (opt "message" D.string)
        (opt "error" D.string)


type alias ChatView =
    { view : String, messages : Int, failure : Maybe String }


chatView : Decoder ChatView
chatView =
    D.map3 ChatView (D.field "view" D.string) (D.field "messages" D.int) (opt "failure" D.string)


type alias SettingsView =
    { chat : Maybe ModelRef, compactorSource : String, compactorModel : Maybe ModelRef, error : Maybe String }


settingsView : Decoder SettingsView
settingsView =
    D.map4 SettingsView
        (opt "chat" modelRef)
        (D.at [ "compactor", "source" ] D.string)
        (optAt [ "compactor", "model" ] modelRef)
        (opt "error" D.string)


type alias Github =
    { state : String, login : Maybe String }


github : Decoder Github
github =
    D.field "github" (D.map2 Github (D.field "state" D.string) (opt "login" D.string))


skills : Decoder (List String)
skills =
    D.at [ "resolved", "skills" ] (D.list (D.oneOf [ D.field "name" D.string, D.field "id" D.string, D.succeed "skill" ]))
