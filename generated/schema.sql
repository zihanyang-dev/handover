--
-- PostgreSQL database dump
--

\restrict handover

-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: browser_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.browser_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: email_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_challenges (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    code_hash text NOT NULL,
    request_key text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    closed_at timestamp with time zone,
    closed_reason text,
    CONSTRAINT email_challenges_closed_reason_check CHECK ((closed_reason = ANY (ARRAY['consumed'::text, 'superseded'::text]))),
    CONSTRAINT email_challenges_closed_together CHECK (((closed_at IS NULL) = (closed_reason IS NULL)))
);


--
-- Name: memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.memberships (
    space_id uuid NOT NULL,
    user_id uuid NOT NULL,
    request_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sign_in_methods; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sign_in_methods (
    user_id uuid NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sign_in_methods_kind_check CHECK ((kind = ANY (ARRAY['google'::text, 'github'::text])))
);


--
-- Name: spaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.spaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    display_name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    verified_email text NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: browser_sessions browser_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_pkey PRIMARY KEY (id);


--
-- Name: browser_sessions browser_sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: email_challenges email_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_challenges
    ADD CONSTRAINT email_challenges_pkey PRIMARY KEY (id);


--
-- Name: email_challenges email_challenges_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_challenges
    ADD CONSTRAINT email_challenges_request_key_key UNIQUE (request_key);


--
-- Name: memberships memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_pkey PRIMARY KEY (space_id, user_id);


--
-- Name: memberships memberships_request_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_request_key_key UNIQUE (request_key);


--
-- Name: sign_in_methods sign_in_methods_kind_subject_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_methods
    ADD CONSTRAINT sign_in_methods_kind_subject_key UNIQUE (kind, subject);


--
-- Name: sign_in_methods sign_in_methods_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_methods
    ADD CONSTRAINT sign_in_methods_pkey PRIMARY KEY (user_id, kind);


--
-- Name: spaces spaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_pkey PRIMARY KEY (id);


--
-- Name: spaces spaces_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.spaces
    ADD CONSTRAINT spaces_slug_key UNIQUE (slug);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: users users_verified_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_verified_email_key UNIQUE (verified_email);


--
-- Name: email_challenges_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX email_challenges_open ON public.email_challenges USING btree (email) WHERE (closed_at IS NULL);


--
-- Name: browser_sessions browser_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.browser_sessions
    ADD CONSTRAINT browser_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: memberships memberships_space_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_space_id_fkey FOREIGN KEY (space_id) REFERENCES public.spaces(id);


--
-- Name: memberships memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.memberships
    ADD CONSTRAINT memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: sign_in_methods sign_in_methods_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sign_in_methods
    ADD CONSTRAINT sign_in_methods_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- PostgreSQL database dump complete
--

\unrestrict handover

