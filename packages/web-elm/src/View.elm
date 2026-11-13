module View exposing (newThreadDialog, view)

import Browser
import Convo
import Data exposing (..)
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Json.Decode as D
import Json.Encode as E
import Model exposing (..)
import Pages
import Phase exposing (Group(..), Phase(..))
import Ui exposing (..)


view : Model -> Browser.Document Msg
view model =
    let
        needs =
            List.length (inGroup { model | projectFilter = Nothing } NeedsYou)

        running =
            List.length (inGroup { model | projectFilter = Nothing } Running)
    in
    { title =
        (if needs > 0 then
            "(" ++ String.fromInt needs ++ ") "

         else
            ""
        )
            ++ (if running > 0 then
                    "▶ "

                else
                    ""
               )
            ++ "cube"
    , body =
        [ div [ class "app" ]
            [ rail model needs running
            , main_ [ class "main" ]
                [ banners model
                , case model.route of
                    Now ->
                        nowPage model

                    Chat ->
                        Convo.chatPage model

                    ThreadPage id ->
                        Convo.threadPage model id

                    Artifacts ->
                        Pages.artifacts model

                    ArtifactPage _ ->
                        Pages.artifact model

                    Projects ->
                        Pages.projects model

                    Runners ->
                        Pages.runners model

                    History ->
                        Pages.history model

                    Settings ->
                        Pages.settings model

                    NotFound path ->
                        div [ class "page" ] [ h1 [] [ text "nothing here" ], p [] [ text ("no page at " ++ path ++ ". "), a [ href "#/" ] [ text "back to now" ] ] ]
                ]
            ]
        , dialog model
        ]
    }


chatState : Model -> ( String, String )
chatState model =
    case model.chatGlance of
        Nothing ->
            ( "quiet", "…" )

        Just glance ->
            case glance.status.state of
                Working ->
                    ( "running", "working" )

                Failed ->
                    ( "failed", "run failed" )

                Completed ->
                    ( "quiet", "turn ended" )

                Stopped ->
                    ( "quiet", "stopped" )

                Idle ->
                    ( "quiet", "idle" )


rail : Model -> Int -> Int -> Html Msg
rail model needs running =
    let
        item route fragment label badge =
            a [ href fragment, classList [ ( "nav-item", True ), ( "current", sameSection route model.route ) ] ]
                [ span [] [ text label ], badge ]

        count n kind =
            if n > 0 then
                span [ class ("badge " ++ kind) ] [ text (String.fromInt n) ]

            else
                text ""

        ( chatClass, chatWords ) =
            chatState model

        flight =
            List.concatMap (inGroup { model | projectFilter = Nothing }) [ NeedsYou, Running, GettingReady ]
    in
    nav [ class "rail", attribute "aria-label" "cube" ]
        [ a [ href "#/", class "brand" ] [ text "cube" ]
        , div [ class "nav" ]
            [ item Now "#/" "now" (span [] [ count needs "needs", count running "running" ])
            , item Chat "#/chat" "optchat" (span [ class ("dot " ++ chatClass), title ("optchat: " ++ chatWords) ] [])
            , item Artifacts "#/artifacts" "artifacts" (text "")
            , item Projects "#/projects" "projects" (text "")
            , item Runners "#/runners" "runners" (text "")
            , item History "#/history" "history" (text "")
            , item Settings "#/settings" "settings" (text "")
            ]
        , div [ class "rail-live" ]
            [ h2 [] [ text "in flight" ]
            , if List.isEmpty flight then
                p [ class "muted" ] [ text "nothing is working or waiting on you." ]

              else
                div []
                    (List.map
                        (\thread ->
                            let
                                value =
                                    phaseOf model thread
                            in
                            a [ href ("#/t/" ++ thread.id), class ("mini " ++ phaseClass value), classList [ ( "current", model.route == ThreadPage thread.id ) ] ]
                                [ glyph value
                                , span [ class "mini-main" ]
                                    [ span [ class "mini-title" ] [ text (threadLabel thread) ]
                                    , span [ class "mini-doing" ] [ text (Phase.label value ++ " · " ++ thread.projectName) ]
                                    ]
                                ]
                        )
                        flight
                    )
            ]
        , div [ class "rail-foot" ]
            [ case model.runners of
                Loaded known ->
                    a [ href "#/runners" ] [ text (String.fromInt known.free ++ " of " ++ String.fromInt known.slots ++ " machine slots free") ]

                _ ->
                    text ""
            , linkNote model
            , button [ class "quiet-button", onClick (Open Help) ] [ text "? keys" ]
            ]
        ]


sameSection : Route -> Route -> Bool
sameSection nav current =
    case ( nav, current ) of
        ( Now, ThreadPage _ ) ->
            True

        ( Artifacts, ArtifactPage _ ) ->
            True

        _ ->
            nav == current


linkNote : Model -> Html Msg
linkNote model =
    case model.link of
        Connecting ->
            span [ class "link" ] [ text "connecting to cubed…" ]

        Live _ ->
            span [ class "link live" ] [ text "connected to cubed" ]

        Lost _ ->
            span [ class "link lost" ] [ text "cubed unreachable" ]


banners : Model -> Html Msg
banners model =
    div [ class "banners" ]
        [ case model.health |> Maybe.andThen .preview of
            Just words ->
                div [ class "banner preview" ] [ text words ]

            Nothing ->
                text ""
        , case model.link of
            Lost lost ->
                div [ class "banner lost", attribute "role" "alert" ]
                    [ strong [] [ text "can't reach cubed. " ]
                    , text
                        ("everything below is as of "
                            ++ (lost.lastOk |> Maybe.map (ago model.now) |> Maybe.withDefault "never (nothing was read yet)")
                            ++ " and may have changed. retrying every 3 s. "
                            ++ lost.why
                        )
                    ]

            _ ->
                text ""
        , if model.activityRoute == Just False then
            div [ class "banner" ] [ text "this cubed reports run states only for threads optchat started; other threads show “run not reported” until opened." ]

          else
            text ""
        , case model.notice of
            Just ( bad, words ) ->
                div [ class "banner notice", classList [ ( "lost", bad ) ], attribute "role" "status" ]
                    [ text words, button [ class "quiet-button", onClick DismissNotice ] [ text "dismiss" ] ]

            Nothing ->
                text ""
        ]


newThreadDialog : Model -> Maybe String -> Dialog
newThreadDialog model projectId =
    NewThread
        { projectId =
            case projectId of
                Just id ->
                    id

                Nothing ->
                    case model.projectFilter of
                        Just id ->
                            id

                        Nothing ->
                            loaded model.projects |> List.filter (\p -> p.status == "ready") |> List.head |> Maybe.map .id |> Maybe.withDefault ""
        , text = ""
        , busy = False
        , error = Nothing
        }


nowPage : Model -> Html Msg
nowPage model =
    let
        section kind emptyWords =
            let
                rows =
                    inGroup model kind

                offset =
                    nowRows model |> List.indexedMap Tuple.pair |> List.filter (\( _, item ) -> List.member item rows) |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault 0
            in
            Html.section [ class ("group " ++ groupClass kind), attribute "aria-label" (Phase.groupLabel kind) ]
                [ h2 [] [ text (Phase.groupLabel kind), span [ class "count" ] [ text (String.fromInt (List.length rows)) ] ]
                , if List.isEmpty rows then
                    empty emptyWords

                  else
                    div [ class "rows" ] (List.indexedMap (\index item -> threadRow model (offset + index == model.cursor) item) rows)
                ]

        quiet =
            inGroup model Quiet

        counts =
            [ ( NeedsYou, "need you" ), ( Running, "working" ), ( GettingReady, "getting ready" ), ( Quiet, "quiet" ) ]
                |> List.map (\( kind, words ) -> String.fromInt (List.length (inGroup model kind)) ++ " " ++ words)
                |> String.join " · "

        ( chatClass, chatWords ) =
            chatState model

        chatLine =
            model.chatGlance
                |> Maybe.map
                    (\glance ->
                        Phase.activityLine
                            (if glance.status.state == Working then
                                Busy

                             else
                                Ended Phase.TurnEnded False
                            )
                            emptyThread
                            glance.events
                    )
                |> Maybe.withDefault ""
    in
    div [ class "page now" ]
        [ header [ class "page-head" ]
            [ div []
                [ h1 [] [ text "now" ]
                , p [ class "summary", attribute "role" "status" ]
                    [ case model.threads of
                        Loading ->
                            text "reading threads…"

                        Unavailable why ->
                            span [ class "problem" ] [ text ("threads could not be read: " ++ why) ]

                        Loaded _ ->
                            text counts
                    ]
                ]
            , div [ class "head-actions" ]
                [ button [ class "quiet-button", onClick MarkAllSeen ] [ text "mark all read" ]
                , button [ class "primary", onClick (Open (newThreadDialog model Nothing)) ] [ text "new thread" ]
                ]
            ]
        , div [ class "filters", attribute "role" "group", attribute "aria-label" "project" ]
            (button [ classList [ ( "chip", True ), ( "on", model.projectFilter == Nothing ) ], onClick (SetProjectFilter Nothing) ] [ text "all projects" ]
                :: List.map
                    (\p ->
                        button [ classList [ ( "chip", True ), ( "on", model.projectFilter == Just p.id ) ], onClick (SetProjectFilter (Just p.id)) ] [ text p.name ]
                    )
                    (loaded model.projects)
            )
        , div [ class "now-grid" ]
            [ div [ class "now-main" ]
                [ a [ href "#/chat", class ("row chat-row " ++ chatClass) ]
                    [ span [ class ("glyph " ++ chatClass) ]
                        [ text
                            (if chatClass == "running" then
                                "▶"

                             else
                                "✉"
                            )
                        ]
                    , div [ class "row-main" ]
                        [ div [ class "row-top" ] [ strong [] [ text "optchat" ], span [ class ("pill " ++ chatClass) ] [ text chatWords ] ]
                        , div [ class "row-doing" ] [ text chatLine ]
                        , div [ class "row-meta" ] [ span [] [ text "your chat: ask for work here; it starts and directs threads" ] ]
                        ]
                    ]
                , section NeedsYou "nothing needs you."
                , section Running "nothing is working right now."
                , section GettingReady "no machine is starting or waiting for a slot."
                , Html.section [ class "group quiet" ]
                    [ h2 []
                        [ button [ class "quiet-button", onClick ToggleQuiet, attribute "aria-expanded" (boolText model.quietOpen) ]
                            [ text
                                ((if model.quietOpen then
                                    "▾ "

                                  else
                                    "▸ "
                                 )
                                    ++ "quiet"
                                )
                            ]
                        , span [ class "count" ] [ text (String.fromInt (List.length quiet)) ]
                        ]
                    , if model.quietOpen then
                        if List.isEmpty quiet then
                            empty "no quiet threads."

                        else
                            let
                                offset =
                                    List.length (nowRows model) - List.length quiet
                            in
                            div [ class "rows" ] (List.indexedMap (\index item -> threadRow model (offset + index == model.cursor) item) quiet)

                      else
                        p [ class "muted" ] [ text "open threads with no run going and nothing unread: turn ended and read, stopped, suspended or never run." ]
                    ]
                ]
            , aside [ class "now-side", attribute "aria-label" "where work runs" ]
                [ h2 [] [ text "where it runs" ]
                , remoteView model.runners "runners" (\known -> div [] (List.map (Pages.runnerCard model True) known.runners))
                ]
            ]
        ]


boolText : Bool -> String
boolText value =
    if value then
        "true"

    else
        "false"


emptyThread : Thread
emptyThread =
    { id = "", title = Nothing, name = Nothing, projectId = "", projectName = "", machine = MachineReady, error = Nothing, failureKind = Nothing, waiting = Nothing, createdAt = 0, archived = False, agent = "pi", model = Nothing, runnerId = Nothing, vmId = Nothing, steps = [], sleep = Nothing, notice = Nothing, retain = Nothing, retainReason = Nothing, discarded = False, startupMs = Nothing, prepared = Nothing }


dialog : Model -> Html Msg
dialog model =
    let
        shell title_ content =
            div [ class "overlay", onClick CloseDialog ]
                [ div [ class "dialog", attribute "role" "dialog", attribute "aria-modal" "true", attribute "aria-label" title_, stopPropagationOn "click" (D.succeed ( NoOp, True )) ]
                    (h2 [] [ text title_ ] :: content)
                ]

        problem error =
            case error of
                Just why ->
                    p [ class "problem", attribute "role" "alert" ] [ text why ]

                Nothing ->
                    text ""

        buttons label busy =
            div [ class "dialog-actions" ]
                [ button [ class "quiet-button", onClick CloseDialog ] [ text "cancel" ]
                , button [ class "primary", onClick SubmitDialog, disabled busy ]
                    [ text
                        (if busy then
                            "working…"

                         else
                            label
                        )
                    ]
                ]
    in
    case model.dialog of
        NoDialog ->
            text ""

        Help ->
            shell "keys"
                [ table [ class "keys" ]
                    (List.map (\( key, what ) -> tr [] [ td [] [ kbd [] [ text key ] ], td [] [ text what ] ])
                        [ ( "g n", "now" ), ( "g c", "optchat" ), ( "g a", "artifacts" ), ( "g p", "projects" ), ( "g r", "runners" ), ( "g h", "history" ), ( "g s", "settings" ), ( "j / k", "move down / up the now list" ), ( "enter", "open the marked thread" ), ( "c", "write a message" ), ( "n", "new thread" ), ( "/", "search (history)" ), ( "esc", "close, leave the field, or back to now" ), ( "?", "this list" ) ]
                    )
                , div [ class "dialog-actions" ] [ button [ class "primary", onClick CloseDialog ] [ text "close" ] ]
                ]

        NewThread form ->
            shell "new thread"
                [ p [ class "muted" ] [ text "a thread is one agent in its own machine, working on one project. its first message starts it." ]
                , label [] [ text "project", select [ id "dialog-first", onInput (DialogField "project") ] (List.map (\p -> option [ value p.id, selected (p.id == form.projectId), disabled (p.status /= "ready") ] [ text (p.name ++ (if p.status == "ready" then "" else " (" ++ p.status ++ ")")) ]) (loaded model.projects)) ]
                , label [] [ text "first message", textarea [ rows 4, value form.text, onInput (DialogField "text"), placeholder "what should it do?" ] [] ]
                , p [ class "muted" ] [ text ("model: " ++ (model.models |> Maybe.andThen .selected |> Maybe.map modelName |> Maybe.withDefault "none connected") ++ " (cubed's preferred model)") ]
                , problem form.error
                , buttons "start thread" form.busy
                ]

        NewProject form ->
            shell "new project"
                [ label [] [ text "name", input [ id "dialog-first", value form.name, onInput (DialogField "name") ] [] ]
                , label [] [ text "repository url", input [ value form.url, onInput (DialogField "url"), placeholder "https://github.com/owner/name" ] [] ]
                , label [] [ text "base branch (empty: the default branch)", input [ value form.base, onInput (DialogField "base") ] [] ]
                , p [ class "muted" ] [ text "cubed checks the repository when you save. hooks and machine size are not editable in this preview." ]
                , problem form.error
                , buttons "save and check" form.busy
                ]

        Rename _ title_ ->
            shell "rename thread"
                [ label [] [ text "title", input [ id "dialog-first", value title_, onInput (DialogField "title"), onEnter SubmitDialog ] [] ]
                , buttons "rename" False
                ]

        Confirm spec ->
            shell spec.title
                [ p [] [ text spec.body ]
                , div [ class "dialog-actions" ]
                    [ button [ class "quiet-button", id "dialog-first", onClick CloseDialog ] [ text "cancel" ]
                    , button [ class "danger", onClick SubmitDialog ] [ text spec.label ]
                    ]
                ]

        RunAction form ->
            shell form.action.label
                [ p [] [ text (form.action.kind ++ " · " ++ form.action.repository ++ "#" ++ String.fromInt form.action.pull ++ " · " ++ form.action.method ++ " at "), code [] [ text (String.left 12 form.action.headSha) ] ]
                , case form.preview of
                    Nothing ->
                        p [ class "muted loading" ] [ text "checking the pull request now…" ]

                    Just (Err error) ->
                        p [ class "problem" ] [ text ("it could not be checked: " ++ error.message) ]

                    Just (Ok known) ->
                        div []
                            [ case known.pullTitle of
                                Just title_ ->
                                    p [] [ text ("pull request: " ++ title_ ++ " (" ++ Maybe.withDefault "?" known.pullState ++ ")") ]

                                Nothing ->
                                    text ""
                            , if List.isEmpty known.problems then
                                label [] [ text ("type " ++ known.confirm ++ " to confirm"), input [ id "dialog-first", value form.typed, onInput (DialogField "confirm") ] [] ]

                              else
                                ul [ class "problem" ] (List.map (\words -> li [] [ text words ]) known.problems)
                            ]
                , case form.result of
                    Just (Ok words) ->
                        p [ class "note", attribute "role" "status" ] [ text words ]

                    Just (Err error) ->
                        p [ class "problem", attribute "role" "alert" ] [ text ("it did not run: " ++ error.message) ]

                    Nothing ->
                        text ""
                , div [ class "dialog-actions" ]
                    [ button [ class "quiet-button", onClick CloseDialog ] [ text "close" ]
                    , button
                        [ class "danger"
                        , onClick SubmitDialog
                        , disabled
                            (form.busy
                                || (case form.preview of
                                        Just (Ok known) ->
                                            not (List.isEmpty known.problems) || form.typed /= known.confirm

                                        _ ->
                                            True
                                   )
                            )
                        ]
                        [ text "run it" ]
                    ]
                ]
