module Main exposing (main)

import Browser
import Browser.Dom as Dom
import Browser.Events
import Browser.Navigation as Nav
import Data exposing (..)
import Dict exposing (Dict)
import Json.Decode as D
import Json.Encode as E
import Model exposing (..)
import Phase
import Ports
import Set
import Task
import Time
import Url exposing (Url)
import View


main : Program D.Value Model Msg
main =
    Browser.application
        { init = init
        , update = update
        , view = View.view
        , subscriptions = subscriptions
        , onUrlChange = UrlChanged
        , onUrlRequest = LinkClicked
        }


seenDecoder : D.Decoder (Dict String String)
seenDecoder =
    D.oneOf [ D.dict D.string, D.succeed Dict.empty ]


init : D.Value -> Url -> Nav.Key -> ( Model, Cmd Msg )
init flags url key =
    let
        model =
            { key = key
            , route = Now
            , now = D.decodeValue (D.field "now" D.int) flags |> Result.withDefault 0
            , visible = True
            , link = Connecting
            , threads = Loading
            , archived = Loading
            , activity = Dict.empty
            , activityRoute = Nothing
            , overview = Dict.empty
            , chatGlance = Nothing
            , projects = Loading
            , runners = Loading
            , artifacts = Loading
            , health = Nothing
            , models = Nothing
            , chatModels = Nothing
            , seen = D.decodeValue (D.field "seen" seenDecoder) flags |> Result.withDefault Dict.empty
            , since = Dict.empty
            , projectFilter = Nothing
            , search = ""
            , conv = Nothing
            , drafts = Dict.empty
            , artifact = Nothing
            , settings = { providers = Loading, github = Loading, update = Loading, usage = Loading, chatView = Loading, settings = Loading, skills = Loading, memoryOpen = False }
            , dialog = NoDialog
            , notice = Nothing
            , cursor = -1
            , goPending = False
            , counter = 0
            , quietOpen = False
            }

        ( entered, enter ) =
            enterRoute (parseRoute url) model
    in
    ( entered, Cmd.batch [ enter, poll entered, slowPoll entered, get "/api/models" models GotModels ] )


parseRoute : Url -> Route
parseRoute url =
    case String.split "/" (Maybe.withDefault "" url.fragment) |> List.filter (String.isEmpty >> not) of
        [] ->
            Now

        [ "chat" ] ->
            Chat

        [ "t", id ] ->
            ThreadPage (Maybe.withDefault id (Url.percentDecode id))

        [ "artifacts" ] ->
            Artifacts

        [ "a", id ] ->
            ArtifactPage id

        [ "projects" ] ->
            Projects

        [ "runners" ] ->
            Runners

        [ "history" ] ->
            History

        [ "settings" ] ->
            Settings

        other ->
            NotFound (String.join "/" other)


newConv : String -> Conv
newConv base =
    { base = base
    , start = 0
    , events = []
    , status = Nothing
    , stream = StreamOpening
    , loaded = False
    , sending = False
    , sendError = Nothing
    , loadingOlder = False
    , expanded = Set.empty
    , models = Nothing
    , steps = Nothing
    , services = Nothing
    , usage = Nothing
    , panel = False
    }


streamUrl : String -> String
streamUrl base =
    base ++ "/stream?tail=150"


threadDetails : String -> Cmd Msg
threadDetails id =
    Cmd.batch
        [ get (threadBase id ++ "/steps") (D.field "steps" (D.list step)) (GotSteps id)
        , get (threadBase id ++ "/services") services (GotServices id)
        , get (threadBase id ++ "/usage") threadUsage (GotUsage id)
        ]


enterRoute : Route -> Model -> ( Model, Cmd Msg )
enterRoute route before =
    let
        model =
            { before | route = route, cursor = -1, goPending = False, dialog = NoDialog, notice = Nothing }

        closed =
            { model | conv = Nothing }

        open base extra =
            ( { model | conv = Just (newConv base) }
            , Cmd.batch [ Ports.streamOpen (streamUrl base), extra, focus "composer" ]
            )
    in
    case route of
        Chat ->
            open chatBase (get (chatBase ++ "/model") models GotChatModels)

        ThreadPage id ->
            open (threadBase id) (Cmd.batch [ get (threadBase id ++ "/model") models (GotThreadModels id), threadDetails id ])

        ArtifactPage id ->
            ( { closed | artifact = Just { id = id, view = Loading, shown = Nothing, revision = Loading, selection = Nothing, body = "", busy = False } }
            , Cmd.batch [ Ports.streamClose (), loadArtifact id ]
            )

        History ->
            ( closed, Cmd.batch [ Ports.streamClose (), get "/api/threads?includeArchived=1" (D.field "threads" (D.list thread)) GotArchived ] )

        Settings ->
            ( closed, Cmd.batch [ Ports.streamClose (), loadSettings ] )

        _ ->
            ( closed, Ports.streamClose () )


loadArtifact : String -> Cmd Msg
loadArtifact id =
    get ("/api/artifacts/" ++ id) artifactView (GotArtifact id)


loadSettings : Cmd Msg
loadSettings =
    Cmd.batch
        [ get "/api/providers" providers GotProviders
        , get "/api/github/auth" github GotGithub
        , get "/api/system/update" Data.update GotUpdate
        , get "/api/usage" usageReport GotUsageReport
        , get (chatBase ++ "/view") chatView GotChatView
        , get "/api/settings" settingsView GotSettings
        , get "/api/settings/skills" skills GotSkills
        ]


focus : String -> Cmd Msg
focus id =
    Task.attempt (\_ -> NoOp) (Dom.focus id)


toBottom : Cmd Msg
toBottom =
    Dom.getViewportOf "transcript"
        |> Task.andThen (\info -> Dom.setViewportOf "transcript" 0 info.scene.height)
        |> Task.attempt (\_ -> NoOp)


{-| Follows the transcript only when the reader is already at its end.
-}
followBottom : Cmd Msg
followBottom =
    Dom.getViewportOf "transcript"
        |> Task.andThen
            (\info ->
                if info.scene.height - info.viewport.y - info.viewport.height < 160 then
                    Dom.setViewportOf "transcript" 0 info.scene.height

                else
                    Task.succeed ()
            )
        |> Task.attempt (\_ -> NoOp)


poll : Model -> Cmd Msg
poll model =
    Cmd.batch
        [ get "/api/threads" (D.field "threads" (D.list thread)) GotThreads
        , if model.activityRoute == Just False then
            get (chatBase ++ "/threads") overview GotOverview

          else
            get "/api/activity" activity GotActivity
        , get (chatBase ++ "/history?tail=6") transcript GotChatGlance
        ]


slowPoll : Model -> Cmd Msg
slowPoll model =
    Cmd.batch
        [ get "/api/projects" (D.field "projects" (D.list project)) GotProjects
        , get "/api/runners/observed" runners GotRunners
        , get "/api/artifacts" (D.field "artifacts" (D.list artifactItem)) GotArtifacts
        , get "/api/health" health GotHealth
        , case model.route of
            ThreadPage id ->
                threadDetails id

            ArtifactPage id ->
                loadArtifact id

            _ ->
                Cmd.none
        ]


subscriptions : Model -> Sub Msg
subscriptions model =
    Sub.batch
        [ Time.every 1000 Tick
        , if model.visible then
            Sub.batch [ Time.every 3000 (\_ -> Poll), Time.every 12000 (\_ -> SlowPoll) ]

          else
            Sub.none
        , Browser.Events.onVisibilityChange VisibilityChanged
        , Browser.Events.onKeyDown
            (D.map3 Key
                (D.field "key" D.string)
                (D.oneOf [ D.at [ "target", "tagName" ] D.string, D.succeed "" ])
                (D.map3 (\ctrl meta alt -> ctrl || meta || alt) (D.field "ctrlKey" D.bool) (D.field "metaKey" D.bool) (D.field "altKey" D.bool))
                |> D.map Pressed
            )
        , Ports.streamFrame StreamFrame
        , Ports.streamState StreamState
        , Ports.seenChanged SeenChanged
        , Ports.selectionMade SelectionMade
        ]


requestId : Model -> String
requestId model =
    "elm-" ++ String.fromInt model.now ++ "-" ++ String.fromInt model.counter


ok : D.Decoder ()
ok =
    D.succeed ()


{-| A read reached cubed, or did not: only a request that never arrived
(status 0) says the link is lost.
-}
linked : Api a -> Model -> Model
linked result model =
    case result of
        Err error ->
            if error.status == 0 then
                case model.link of
                    Lost _ ->
                        model

                    Live at ->
                        { model | link = Lost { since = model.now, lastOk = Just at, why = error.message } }

                    Connecting ->
                        { model | link = Lost { since = model.now, lastOk = Nothing, why = error.message } }

            else
                model

        Ok _ ->
            { model | link = Live model.now }


remote : Remote a -> Api a -> Remote a
remote before result =
    case ( result, before ) of
        ( Ok value, _ ) ->
            Loaded value

        ( Err _, Loaded value ) ->
            Loaded value

        ( Err error, _ ) ->
            Unavailable error.message


{-| Remembers when this window first saw each thread's run working.
-}
noteWorking : Model -> Model
noteWorking model =
    let
        note item since =
            case (runOf model item).run of
                Just status ->
                    if status.state == Working then
                        let
                            run =
                                Maybe.withDefault "" status.run
                        in
                        case Dict.get item.id since of
                            Just ( known, _ ) ->
                                if known == run then
                                    since

                                else
                                    Dict.insert item.id ( run, model.now ) since

                            Nothing ->
                                Dict.insert item.id ( run, model.now ) since

                    else
                        Dict.remove item.id since

                Nothing ->
                    since
    in
    { model | since = List.foldl note model.since (loaded model.threads) }


markSeen : String -> RunStatus -> Model -> ( Model, Cmd Msg )
markSeen id status model =
    if List.member status.state [ Completed, Failed, Stopped ] && model.visible && Dict.get id model.seen /= Just (Phase.runKey status) then
        let
            seen =
                Dict.insert id (Phase.runKey status) model.seen
        in
        ( { model | seen = seen }, Ports.saveSeen (E.dict identity E.string seen) )

    else
        ( model, Cmd.none )


convId : String -> String
convId base =
    if base == chatBase then
        "optchat"

    else
        String.replace "/api/threads/" "" base |> Url.percentDecode |> Maybe.withDefault base


updateConv : (Conv -> Conv) -> Model -> Model
updateConv change model =
    { model | conv = Maybe.map change model.conv }


go : Model -> String -> Cmd Msg
go model fragment =
    Nav.pushUrl model.key fragment


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        NoOp ->
            ( model, Cmd.none )

        UrlChanged url ->
            enterRoute (parseRoute url) model

        LinkClicked request ->
            case request of
                Browser.Internal url ->
                    ( model, Nav.pushUrl model.key (Url.toString url) )

                Browser.External href ->
                    ( model, Nav.load href )

        Tick time ->
            ( { model | now = Time.posixToMillis time }, Cmd.none )

        Poll ->
            -- A stream cubed refused (a machine not up yet) is asked for again.
            ( model
            , Cmd.batch
                [ poll model
                , case model.conv of
                    Just conv ->
                        case conv.stream of
                            StreamEnded _ ->
                                Ports.streamOpen (streamUrl conv.base)

                            _ ->
                                Cmd.none

                    Nothing ->
                        Cmd.none
                ]
            )

        SlowPoll ->
            ( model, slowPoll model )

        VisibilityChanged visibility ->
            let
                visible =
                    visibility == Browser.Events.Visible
            in
            ( { model | visible = visible }
            , if visible then
                Cmd.batch [ poll model, slowPoll model ]

              else
                Cmd.none
            )

        GotThreads result ->
            ( noteWorking (linked result { model | threads = remote model.threads result }), Cmd.none )

        GotArchived result ->
            ( { model | archived = remote model.archived (Result.map (List.filter .archived) result) }, Cmd.none )

        GotActivity result ->
            case result of
                Ok value ->
                    ( noteWorking { model | activity = value, activityRoute = Just True }, Cmd.none )

                Err error ->
                    if error.status == 404 then
                        ( { model | activityRoute = Just False }, get (chatBase ++ "/threads") overview GotOverview )

                    else
                        ( model, Cmd.none )

        GotOverview result ->
            ( noteWorking { model | overview = Result.withDefault model.overview result }, Cmd.none )

        GotChatGlance result ->
            ( { model | chatGlance = Result.toMaybe result |> orElse model.chatGlance }, Cmd.none )

        GotProjects result ->
            ( { model | projects = remote model.projects result }, Cmd.none )

        GotRunners result ->
            ( { model | runners = remote model.runners result }, Cmd.none )

        GotArtifacts result ->
            ( { model | artifacts = remote model.artifacts result }, Cmd.none )

        GotHealth result ->
            ( { model | health = Result.toMaybe result |> orElse model.health }, Cmd.none )

        GotModels result ->
            ( { model | models = Result.toMaybe result }, Cmd.none )

        GotChatModels result ->
            ( { model | chatModels = Result.toMaybe result }, Cmd.none )

        StreamFrame value ->
            case ( model.conv, D.decodeValue (D.map2 Tuple.pair (D.field "url" D.string) (D.field "transcript" transcript)) value ) of
                ( Just conv, Ok ( url, frame ) ) ->
                    if not (String.startsWith conv.base url) then
                        ( model, Cmd.none )

                    else
                        let
                            events =
                                if conv.loaded && frame.start >= conv.start then
                                    List.take (frame.start - conv.start) conv.events ++ frame.events

                                else
                                    frame.events

                            next =
                                { conv
                                    | events = events
                                    , start =
                                        if conv.loaded then
                                            min conv.start frame.start

                                        else
                                            frame.start
                                    , status = Just frame.status
                                    , stream = StreamOpen
                                    , loaded = True
                                }

                            ( seen, save ) =
                                markSeen (convId conv.base) frame.status { model | conv = Just next }
                        in
                        ( noteWorking seen
                        , Cmd.batch
                            [ save
                            , if conv.loaded then
                                followBottom

                              else
                                toBottom
                            ]
                        )

                _ ->
                    ( model, Cmd.none )

        StreamState value ->
            case ( model.conv, D.decodeValue (D.map2 Tuple.pair (D.field "url" D.string) (D.field "state" D.string)) value ) of
                ( Just conv, Ok ( url, state ) ) ->
                    if not (String.startsWith conv.base url) then
                        ( model, Cmd.none )

                    else
                        ( { model
                            | conv =
                                Just
                                    { conv
                                        | stream =
                                            if state == "open" then
                                                StreamOpen

                                            else if state == "lost" then
                                                StreamLost

                                            else
                                                StreamEnded (String.replace "ended: " "" state)
                                    }
                          }
                        , Cmd.none
                        )

                _ ->
                    ( model, Cmd.none )

        LoadOlder ->
            case model.conv of
                Just conv ->
                    if conv.start > 0 && not conv.loadingOlder then
                        ( updateConv (\c -> { c | loadingOlder = True }) model
                        , get (conv.base ++ "/history?before=" ++ String.fromInt conv.start ++ "&limit=100") page (GotOlder conv.base)
                        )

                    else
                        ( model, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        GotOlder base result ->
            ( updateConv
                (\conv ->
                    if conv.base /= base then
                        conv

                    else
                        case result of
                            Ok older ->
                                if older.start + List.length older.events == conv.start then
                                    { conv | loadingOlder = False, start = older.start, events = older.events ++ conv.events }

                                else
                                    { conv | loadingOlder = False }

                            Err error ->
                                { conv | loadingOlder = False, sendError = Just ("earlier messages: " ++ error.message) }
                )
                model
            , Cmd.none
            )

        DraftChanged base text ->
            ( { model | drafts = Dict.insert base text model.drafts }, Cmd.none )

        Send base ->
            let
                text =
                    Dict.get base model.drafts |> Maybe.withDefault "" |> String.trim
            in
            if String.isEmpty text || (model.conv |> Maybe.map .sending |> Maybe.withDefault False) then
                ( model, Cmd.none )

            else
                ( updateConv (\conv -> { conv | sending = True, sendError = Nothing }) { model | counter = model.counter + 1 }
                , send "POST" (base ++ "/prompt") (E.object [ ( "text", E.string text ), ( "requestId", E.string (requestId model) ) ]) ok (Sent base)
                )

        Sent base result ->
            case result of
                Ok () ->
                    ( updateConv (\conv -> { conv | sending = False }) { model | drafts = Dict.remove base model.drafts }, Cmd.batch [ toBottom, poll model ] )

                Err error ->
                    ( updateConv (\conv -> { conv | sending = False, sendError = Just error.message }) model, Cmd.none )

        Stop base ->
            ( model, send "POST" (base ++ "/stop") (E.object []) ok (Did "stop asked") )

        Toggle id ->
            ( updateConv
                (\conv ->
                    { conv
                        | expanded =
                            if Set.member id conv.expanded then
                                Set.remove id conv.expanded

                            else
                                Set.insert id conv.expanded
                    }
                )
                model
            , Cmd.none
            )

        TogglePanel ->
            ( updateConv (\conv -> { conv | panel = not conv.panel }) model, Cmd.none )

        GotThreadModels id result ->
            ( updateConv
                (\conv ->
                    if conv.base == threadBase id then
                        { conv | models = Result.toMaybe result |> orElse conv.models }

                    else
                        conv
                )
                model
            , Cmd.none
            )

        SetModel base name ->
            case String.split "/" name of
                provider :: rest ->
                    ( model
                    , send "PATCH" (base ++ "/model") (encodeModel { provider = provider, id = String.join "/" rest }) models <|
                        if base == chatBase then
                            GotChatModels

                        else
                            GotThreadModels (convId base)
                    )

                [] ->
                    ( model, Cmd.none )

        GotSteps id result ->
            ( updateConv
                (\conv ->
                    if conv.base == threadBase id then
                        { conv | steps = Result.toMaybe result |> orElse conv.steps }

                    else
                        conv
                )
                model
            , Cmd.none
            )

        GotServices id result ->
            ( updateConv
                (\conv ->
                    if conv.base == threadBase id then
                        { conv | services = Just result }

                    else
                        conv
                )
                model
            , Cmd.none
            )

        GotUsage id result ->
            ( updateConv
                (\conv ->
                    if conv.base == threadBase id then
                        { conv | usage = Result.toMaybe result |> orElse conv.usage }

                    else
                        conv
                )
                model
            , Cmd.none
            )

        SeenChanged value ->
            ( { model | seen = D.decodeValue seenDecoder value |> Result.withDefault model.seen }, Cmd.none )

        MarkAllSeen ->
            let
                seen =
                    List.foldl
                        (\item known ->
                            case (runOf model item).run of
                                Just status ->
                                    Dict.insert item.id (Phase.runKey status) known

                                Nothing ->
                                    known
                        )
                        model.seen
                        (loaded model.threads)
            in
            ( { model | seen = seen }, Ports.saveSeen (E.dict identity E.string seen) )

        SetProjectFilter filter ->
            ( { model | projectFilter = filter, cursor = -1 }, Cmd.none )

        SetSearch text ->
            ( { model | search = text }, Cmd.none )

        ToggleQuiet ->
            ( { model | quietOpen = not model.quietOpen }, Cmd.none )

        Pressed key ->
            pressed key model

        Open dialog ->
            ( { model | dialog = dialog }
            , case dialog of
                RunAction form ->
                    case model.artifact of
                        Just state ->
                            get ("/api/artifacts/" ++ state.id ++ "/actions/" ++ Url.percentEncode form.action.id ++ "?revision=" ++ String.fromInt (Maybe.withDefault 0 state.shown)) preview GotPreview

                        Nothing ->
                            Cmd.none

                NoDialog ->
                    Cmd.none

                _ ->
                    focus "dialog-first"
            )

        CloseDialog ->
            ( { model | dialog = NoDialog }, Cmd.none )

        DialogField name value ->
            ( { model
                | dialog =
                    case model.dialog of
                        NewThread form ->
                            NewThread
                                (if name == "project" then
                                    { form | projectId = value }

                                 else
                                    { form | text = value }
                                )

                        NewProject form ->
                            NewProject
                                (case name of
                                    "name" ->
                                        { form | name = value }

                                    "url" ->
                                        { form | url = value }

                                    _ ->
                                        { form | base = value }
                                )

                        Rename id _ ->
                            Rename id value

                        RunAction form ->
                            RunAction { form | typed = value }

                        other ->
                            other
              }
            , Cmd.none
            )

        SubmitDialog ->
            let
                counted =
                    { model | counter = model.counter + 1 }
            in
            case model.dialog of
                NewThread form ->
                    if String.isEmpty (String.trim form.text) || String.isEmpty form.projectId then
                        ( { model | dialog = NewThread { form | error = Just "choose a project and write the first message" } }, Cmd.none )

                    else
                        ( { counted | dialog = NewThread { form | busy = True, error = Nothing } }
                        , send "POST" "/api/threads" (E.object [ ( "projectId", E.string form.projectId ), ( "requestId", E.string (requestId model) ), ( "text", E.string form.text ) ]) (D.field "id" D.string) Created
                        )

                NewProject form ->
                    ( { model | dialog = NewProject { form | busy = True, error = Nothing } }
                    , send "POST"
                        "/api/projects"
                        (E.object
                            [ ( "name", E.string form.name )
                            , ( "repositories"
                              , E.list identity
                                    [ E.object
                                        (( "url", E.string form.url )
                                            :: (if String.isEmpty (String.trim form.base) then
                                                    []

                                                else
                                                    [ ( "base", E.string form.base ) ]
                                               )
                                        )
                                    ]
                              )
                            ]
                        )
                        (D.field "project" project)
                        ProjectSaved
                    )

                Rename id title ->
                    ( { model | dialog = NoDialog }, send "PATCH" (threadBase id) (E.object [ ( "title", E.string title ) ]) ok (Did "renamed") )

                RunAction form ->
                    case ( model.artifact, form.busy ) of
                        ( Just state, False ) ->
                            ( { counted | dialog = RunAction { form | busy = True } }
                            , send "POST"
                                ("/api/artifacts/" ++ state.id ++ "/actions/" ++ Url.percentEncode form.action.id)
                                (E.object [ ( "revision", E.int (Maybe.withDefault 0 state.shown) ), ( "confirm", E.string form.typed ), ( "requestId", E.string (requestId model) ) ])
                                (D.map2 (\state_ detail -> state_ ++ ": " ++ detail) (D.field "state" D.string) (D.field "detail" D.string))
                                ActionRan
                            )

                        _ ->
                            ( model, Cmd.none )

                Confirm spec ->
                    update spec.run { model | dialog = NoDialog }

                _ ->
                    ( model, Cmd.none )

        Created result ->
            case ( result, model.dialog ) of
                ( Ok id, _ ) ->
                    ( { model | dialog = NoDialog }, Cmd.batch [ go model ("#/t/" ++ id), poll model ] )

                ( Err error, NewThread form ) ->
                    ( { model | dialog = NewThread { form | busy = False, error = Just error.message } }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        ProjectSaved result ->
            case ( result, model.dialog ) of
                ( Ok saved, _ ) ->
                    ( { model
                        | dialog = NoDialog
                        , notice =
                            Just
                                (if saved.status == "ready" then
                                    ( False, "project " ++ saved.name ++ " is ready" )

                                 else
                                    ( True, "project " ++ saved.name ++ " was saved but is " ++ saved.status ++ (Maybe.map (\e -> ": " ++ e) saved.error |> Maybe.withDefault "") )
                                )
                      }
                    , slowPoll model
                    )

                ( Err error, NewProject form ) ->
                    ( { model | dialog = NewProject { form | busy = False, error = Just error.message } }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        Do _ cmd ->
            ( { model | dialog = NoDialog }, cmd )

        Did what result ->
            case result of
                Ok () ->
                    ( { model | notice = Just ( False, what ) }, Cmd.batch [ poll model, slowPoll model ] )

                Err error ->
                    ( { model | notice = Just ( True, what ++ " did not happen: " ++ error.message ) }, Cmd.none )

        DidGo what fragment result ->
            case result of
                Ok () ->
                    ( { model | notice = Just ( False, what ) }, Cmd.batch [ go model fragment, poll model ] )

                Err error ->
                    ( { model | notice = Just ( True, what ++ " did not happen: " ++ error.message ) }, Cmd.none )

        GotArtifact id result ->
            case model.artifact of
                Just state ->
                    if state.id /= id then
                        ( model, Cmd.none )

                    else
                        let
                            shown =
                                case ( state.shown, result ) of
                                    ( Nothing, Ok value ) ->
                                        Just value.item.head

                                    _ ->
                                        state.shown
                        in
                        ( { model | artifact = Just { state | view = remote state.view result, shown = shown } }
                        , case ( state.shown, shown ) of
                            ( Nothing, Just number ) ->
                                get ("/api/artifacts/" ++ id ++ "/revisions/" ++ String.fromInt number) revision (GotRevision id)

                            _ ->
                                Cmd.none
                        )

                Nothing ->
                    ( model, Cmd.none )

        GotRevision id result ->
            ( { model
                | artifact =
                    model.artifact
                        |> Maybe.map
                            (\state ->
                                if state.id == id then
                                    { state | revision = remote Loading result }

                                else
                                    state
                            )
              }
            , Cmd.none
            )

        ShowRevision number ->
            case model.artifact of
                Just state ->
                    ( { model | artifact = Just { state | shown = Just number, revision = Loading, selection = Nothing } }
                    , get ("/api/artifacts/" ++ state.id ++ "/revisions/" ++ String.fromInt number) revision (GotRevision state.id)
                    )

                Nothing ->
                    ( model, Cmd.none )

        SelectionMade value ->
            ( { model | artifact = model.artifact |> Maybe.map (\state -> { state | selection = D.decodeValue anchor value |> Result.toMaybe |> orElse state.selection }) }
            , Cmd.none
            )

        CommentBody text ->
            ( { model | artifact = model.artifact |> Maybe.map (\state -> { state | body = text }) }, Cmd.none )

        AddComment ->
            case model.artifact of
                Just state ->
                    case ( state.selection, state.shown, String.isEmpty (String.trim state.body) ) of
                        ( Just selected, Just number, False ) ->
                            ( { model | artifact = Just { state | busy = True }, counter = model.counter + 1 }
                            , send "POST"
                                ("/api/artifacts/" ++ state.id ++ "/comments")
                                (E.object [ ( "revision", E.int number ), ( "anchor", encodeAnchor selected ), ( "body", E.string state.body ), ( "requestId", E.string (requestId model) ) ])
                                ok
                                CommentSaved
                            )

                        _ ->
                            ( model, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        CommentSaved result ->
            case model.artifact of
                Just state ->
                    case result of
                        Ok () ->
                            ( { model | artifact = Just { state | busy = False, body = "", selection = Nothing } }, loadArtifact state.id )

                        Err error ->
                            ( { model | artifact = Just { state | busy = False }, notice = Just ( True, "the comment was not saved: " ++ error.message ) }, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        GotPreview result ->
            case model.dialog of
                RunAction form ->
                    ( { model | dialog = RunAction { form | preview = Just result } }, Cmd.none )

                _ ->
                    ( model, Cmd.none )

        ActionRan result ->
            case model.dialog of
                RunAction form ->
                    ( { model | dialog = RunAction { form | busy = False, result = Just result } }
                    , model.artifact |> Maybe.map (.id >> loadArtifact) |> Maybe.withDefault Cmd.none
                    )

                _ ->
                    ( model, Cmd.none )

        GotProviders result ->
            settings (\s -> { s | providers = remote s.providers result }) model

        GotGithub result ->
            settings (\s -> { s | github = remote s.github result }) model

        GotUpdate result ->
            settings (\s -> { s | update = remote s.update result }) model

        GotUsageReport result ->
            settings (\s -> { s | usage = remote s.usage result }) model

        GotChatView result ->
            settings (\s -> { s | chatView = remote s.chatView result }) model

        GotSettings result ->
            settings (\s -> { s | settings = remote s.settings result }) model

        GotSkills result ->
            settings (\s -> { s | skills = remote s.skills result }) model

        ToggleMemory ->
            settings (\s -> { s | memoryOpen = not s.memoryOpen }) model

        DismissNotice ->
            ( { model | notice = Nothing }, Cmd.none )


settings : (SettingsData -> SettingsData) -> Model -> ( Model, Cmd Msg )
settings change model =
    ( { model | settings = change model.settings }, Cmd.none )


orElse : Maybe a -> Maybe a -> Maybe a
orElse fallback value =
    case value of
        Just _ ->
            value

        Nothing ->
            fallback


pressed : Key -> Model -> ( Model, Cmd Msg )
pressed key model =
    let
        typing =
            List.member key.tag [ "INPUT", "TEXTAREA", "SELECT" ]

        rows =
            nowRows model

        to fragment =
            ( { model | goPending = False }, go model fragment )
    in
    if key.key == "Escape" then
        if model.dialog /= NoDialog then
            ( { model | dialog = NoDialog }, Cmd.none )

        else if typing then
            ( model, Task.attempt (\_ -> NoOp) (Dom.blur "composer") )

        else if model.route /= Now then
            to "#/"

        else
            ( model, Cmd.none )

    else if typing || key.modified || model.dialog /= NoDialog then
        ( model, Cmd.none )

    else if model.goPending then
        case key.key of
            "n" ->
                to "#/"

            "c" ->
                to "#/chat"

            "a" ->
                to "#/artifacts"

            "p" ->
                to "#/projects"

            "r" ->
                to "#/runners"

            "h" ->
                to "#/history"

            "s" ->
                to "#/settings"

            _ ->
                ( { model | goPending = False }, Cmd.none )

    else
        case key.key of
            "g" ->
                ( { model | goPending = True }, Cmd.none )

            "?" ->
                ( { model | dialog = Help }, Cmd.none )

            "j" ->
                ( { model | cursor = min (List.length rows - 1) (model.cursor + 1) |> max 0 }, Cmd.none )

            "k" ->
                ( { model | cursor = max 0 (model.cursor - 1) }, Cmd.none )

            "Enter" ->
                case ( model.route, List.drop model.cursor rows |> List.head ) of
                    ( Now, Just item ) ->
                        to ("#/t/" ++ item.id)

                    _ ->
                        ( model, Cmd.none )

            "c" ->
                ( model, focus "composer" )

            "/" ->
                ( model, focus "search" )

            "n" ->
                update (Open (View.newThreadDialog model Nothing)) model

            _ ->
                ( model, Cmd.none )
