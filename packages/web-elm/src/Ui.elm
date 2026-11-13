module Ui exposing (..)

{-| Small pieces every page uses.
-}

import Data exposing (..)
import Dict
import Html exposing (..)
import Html.Attributes exposing (..)
import Html.Events exposing (..)
import Json.Decode as D
import Markdown.Parser
import Markdown.Renderer
import Model exposing (..)
import Phase exposing (Group(..), Phase(..))


markdown : String -> Html msg
markdown source =
    case
        Markdown.Parser.parse source
            |> Result.mapError (\_ -> "")
            |> Result.andThen (Markdown.Renderer.render Markdown.Renderer.defaultHtmlRenderer)
    of
        Ok blocks ->
            div [ class "md" ] blocks

        Err _ ->
            pre [ class "md plain" ] [ text source ]


{-| "12 s", "3 min", "2 h", "5 d".
-}
duration : Int -> String
duration ms =
    let
        seconds =
            Basics.max 0 (ms // 1000)
    in
    if seconds < 90 then
        String.fromInt seconds ++ " s"

    else if seconds < 5400 then
        String.fromInt (seconds // 60) ++ " min"

    else if seconds < 172800 then
        String.fromInt (seconds // 3600) ++ " h"

    else
        String.fromInt (seconds // 86400) ++ " d"


ago : Int -> Int -> String
ago now at =
    duration (now - at) ++ " ago"


groupClass : Group -> String
groupClass value =
    case value of
        NeedsYou ->
            "needs"

        Running ->
            "running"

        GettingReady ->
            "preparing"

        Quiet ->
            "quiet"


phaseClass : Phase -> String
phaseClass value =
    case value of
        MachineFailed _ ->
            "failed"

        Ended (Phase.RunFailed _) _ ->
            "failed"

        Asleep ->
            "asleep"

        _ ->
            groupClass (Phase.group value)


{-| The state mark: a shape and a colour, never colour alone.
-}
glyph : Phase -> Html msg
glyph value =
    span [ class ("glyph " ++ phaseClass value), attribute "aria-hidden" "true" ]
        [ text
            (case value of
                MachineFailed _ ->
                    "✕"

                Ended (Phase.RunFailed _) _ ->
                    "✕"

                Ended Phase.RunStopped _ ->
                    "■"

                Ended _ True ->
                    "●"

                Ended _ False ->
                    "✓"

                Busy ->
                    "▶"

                Background _ ->
                    "▶"

                Starting ->
                    "◌"

                WaitingSlot _ ->
                    "⧖"

                WakingUp ->
                    "◌"

                Asleep ->
                    "☾"

                NeverRan ->
                    "○"

                Unreported ->
                    "?"
            )
        ]


pill : Phase -> Html msg
pill value =
    span [ class ("pill " ++ phaseClass value) ] [ text (Phase.label value) ]


runnerName : Model -> Thread -> String
runnerName model item =
    case item.runnerId of
        Nothing ->
            "no runner yet"

        Just id ->
            case model.runners of
                Loaded known ->
                    known.runners |> List.filter (\r -> r.id == id) |> List.head |> Maybe.map .nodeId |> Maybe.withDefault id

                _ ->
                    id


{-| How long the phase has lasted, where something says so.
-}
elapsed : Model -> Thread -> Phase -> Maybe ( String, String )
elapsed model item value =
    case value of
        Busy ->
            Dict.get item.id model.since
                |> Maybe.map Tuple.second
                |> Maybe.map (\at -> ( duration (model.now - at), "since this window first saw the run working; cubed reports no start time" ))

        Starting ->
            item.steps |> List.head |> Maybe.map (\first -> ( duration (model.now - first.startedAt), "since the first startup step" ))

        WaitingSlot _ ->
            case item.sleep of
                Just (Data.Queued _ at) ->
                    Just ( duration (model.now - at), "in the runner's queue" )

                _ ->
                    Nothing

        Asleep ->
            case item.sleep of
                Just (Data.Suspended at) ->
                    Just ( duration (model.now - at), "since its machine was suspended" )

                _ ->
                    Nothing

        _ ->
            Nothing


onEnter : msg -> Attribute msg
onEnter msg =
    preventDefaultOn "keydown"
        (D.map3 (\key shift composing -> ( key, shift, composing )) (D.field "key" D.string) (D.field "shiftKey" D.bool) (D.oneOf [ D.field "isComposing" D.bool, D.succeed False ])
            |> D.andThen
                (\( key, shift, composing ) ->
                    if key == "Enter" && not shift && not composing then
                        D.succeed ( msg, True )

                    else
                        D.fail "not a send"
                )
        )


remoteView : Remote a -> String -> (a -> Html msg) -> Html msg
remoteView remote what view =
    case remote of
        Loading ->
            p [ class "muted loading" ] [ text ("reading " ++ what ++ "…") ]

        Unavailable why ->
            p [ class "problem" ] [ text (what ++ " could not be read: " ++ why) ]

        Loaded value ->
            view value


empty : String -> Html msg
empty words =
    p [ class "empty" ] [ text words ]


threadRow : Model -> Bool -> Thread -> Html Msg
threadRow model current item =
    let
        value =
            phaseOf model item

        known =
            runOf model item
    in
    a
        [ href ("#/t/" ++ item.id)
        , classList [ ( "row", True ), ( phaseClass value, True ), ( "cursor", current ) ]
        , attribute "data-thread" item.id
        , attribute "data-phase" (Phase.label value)
        ]
        [ glyph value
        , div [ class "row-main" ]
            [ div [ class "row-top" ]
                [ strong [] [ text (threadLabel item) ]
                , pill value
                , case elapsed model item value of
                    Just ( time, why ) ->
                        span [ class "elapsed", title why ] [ text time ]

                    Nothing ->
                        text ""
                ]
            , div [ class "row-doing" ] [ text (Phase.activityLine value item known.events) ]
            , div [ class "row-meta" ]
                [ span [ class "tag" ] [ text item.projectName ]
                , span [] [ text ("on " ++ runnerName model item) ]
                , span [] [ text (item.agent ++ (item.model |> Maybe.map (\m -> " · " ++ m.id) |> Maybe.withDefault "")) ]
                , span [] [ text (Maybe.withDefault "" item.name) ]
                , code [] [ text (shortId item.id) ]
                ]
            ]
        ]
