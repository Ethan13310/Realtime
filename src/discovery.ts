// Copyright (c) 2019 Ethan Margaillan <contact@ethan.jp>.
// Licensed under the MIT Licence - https://raw.githubusercontent.com/Ethan13310/Realtime/master/LICENSE

import * as jwt from 'jsonwebtoken';
import { EventEmitter } from 'events';
import { IRoomSummary } from './room';
import { IClientSummary } from './client';
import { Client as NatsClient } from 'nats';
import { IRoomList, IRoomServer, IRoomServerPing } from './room-server';

/**
 * Représentation des options passées au générateur de token de connexion.
 *
 * @interface ITokenOptions
 */

export interface ITokenOptions
{
    /**
     * L'url du serveur auquel se connecter.
     */
    publicUrl: string,

    /**
     * L'id du salon à rejoindre.
     */
    roomId: string,

    /**
     * Les propriétés du salon à rejoindre.
     */
    roomProperties?: any;

    /**
     * L'id du nouveau client.
     */
    clientId: string,

    /**
     * Les propriétés du nouveau client.
     */
    clientProperties?: any;

    /**
     * Si défini à true, alors ce token est valide uniquement pour rejoindre
     * un salon existant. S'il n'existe pas, aucun nouveau salon sera créé et
     * une erreur sera retournée au client.
     */
    joinOnly?: boolean;

    /**
     * Le délais d'expiration du token.
     */
    expiresIn?: string;
}

/**
 * Classe représentant un serveur de discovery.
 *
 * @class Discovery
 */

export class Discovery extends EventEmitter
{
    /**
     * L'instance du client NATS.
     */
    private readonly _nats: NatsClient;

    /**
     * La liste des room servers.
     *
     * Key: L'url du serveur.
     * Value: Les données du serveur.
     */
    private readonly _roomServers = new Map<string, IRoomServer>();

    /**
     * Durée au delà de laquelle un room server est considéré comme arrêté s'il
     * n'a plus envoyé de ping.
     */
    private readonly _serverTimeout: number = 5000;

    /**
     * La clé de génération des JSON web tokens.
     */
    private readonly _tokenSecret: string = process.env.DISCOVERY_SECRET || 'defaultSecret';

    /**
     * La boucle de vérification des room servers.
     */
    private _checkLoopInterval?: NodeJS.Timeout;

    /**
     * La liste des abonnements NATS.
     */
    private _subscriptions: Array<number> = [];

    /**
     * Constructeur du serveur de discovery.
     *
     * @param {NatsClient} nats - L'instance du client NATS.
     */

    public constructor(nats: NatsClient)
    {
        super();

        this._nats = nats;

        // On démarre la boucle de vérification des room servers
        this._checkLoopInterval = setInterval(() => this._serverCheckLoop(), this._serverTimeout / 2);

        // Réception d'un ping d'un room server
        this._subscribe('ping', (server: IRoomServerPing) =>
        {
            this._receiveServerPing(server);
        });

        // Réception d'un broadcast
        this._subscribe('broadcast', (message: any) =>
        {
            this.emit('broadcast', message);
        });

        // Evénement d'un room server
        this._subscribe('rs.event', (event: any) =>
        {
            this._handleServerEvent(event);
        });

        // Arrêt d'un room server
        this._subscribe('rs.stop', (publicUrl: string) =>
        {
            this._removeServerByUrl(publicUrl);
        });
    }

    /**
     * Arrête le serveur de discovery.
     */

    public stop()
    {
        if (!this._checkLoopInterval)
        {
            // Déjà arrêté
            return;
        }

        // On clear les abonnements NATS
        this._subscriptions.forEach((subcription: number) =>
        {
            this._nats.unsubscribe(subcription);
        });

        this._subscriptions = [];

        // On arrête la boucle de vérification des room servers
        clearInterval(this._checkLoopInterval);

        this._checkLoopInterval = undefined;

        this.emit('stop');
    }

    /**
     * Retourne le nombre de clients connectés au serveur dont l'url est
     * passée en paramètre.
     *
     * @param {string} publicUrl - L'url du serveur.
     *
     * @returns {number | null}
     */

    public getClientCount(publicUrl: string): number | null
    {
        const roomServer = this._roomServers.get(publicUrl);

        if (!roomServer)
        {
            // Le serveur n'existe pas
            return null;
        }

        return roomServer.clientCount;
    }

    /**
     * Retourne le room server le moins chargé, c'est à dire avec le moins de
     * clients connectés. Retourne 'null' si aucun room server n'est
     * disponible.
     *
     * @returns {IRoomServer | null}
     */

    public getLeastLoadedServer(): IRoomServer | null
    {
        let bestServer: IRoomServer | null = null;
        let bestClientCount: number = Infinity;

        this._roomServers.forEach((server: IRoomServer) =>
        {
            if (server.clientCount < bestClientCount)
            {
                // Ce room server possède le moins de clients
                bestServer = server;
                bestClientCount = server.clientCount;
            }
        });

        return bestServer;
    }

    /**
     * Génère un JSON web token de connexion à un salon.
     *
     * @param {ITokenOptions} options - Les options de génération du token.
     *
     * @returns {string} Le JSON web token.
     */

    public generateToken(options: ITokenOptions): string
    {
        // Délais d'expiration du token, par défaut une minute
        const expiresIn = options.expiresIn || '1m';

        const payload = {
            publicUrl: options.publicUrl,
            roomId: options.roomId,
            roomProperties: options.roomProperties,
            clientId: options.clientId,
            clientProperties: options.clientProperties,
            joinOnly: options.joinOnly
        };

        return jwt.sign(payload, this._tokenSecret, {
            expiresIn: expiresIn,
            subject: 'joinRoom'
        });
    }

    /**
     * Diffuse un message à tous les salons et serveurs de discovery.
     *
     * @param {*} message - Le message à envoyer.
     */

    public broadcast(message: any)
    {
        this._nats.publish('broadcast', message);
    }

    /**
     * Gère un événement envoyé par un room server.
     *
     * @param {*} event - Les données de l'événement.
     *
     * @private
     */

    private _handleServerEvent(event: any)
    {
        const roomServer = this._roomServers.get(event.publicUrl);

        if (!roomServer)
        {
            // Le room server n'est pas connu du serveur de discovery
            return;
        }

        if (event.subject === 'newRoom')
        {
            return this._addNewRoom(roomServer, {
                id: event.roomId,
                publicUrl: event.publicUrl,
                properties: event.properties,
                clients: {}
            });
        }

        const room = roomServer.rooms[event.roomId];

        if (!room)
        {
            // Le salon n'est pas connu du serveur de discovery
            return;
        }

        switch (event.subject)
        {
            case 'roomRemoved':
                this._removeRoom(roomServer, room.id);
                break;

            case 'roomJoined':
                this._addNewClient(room, event.client);
                break;

            case 'roomLeft':
                this._removeClient(room, event.client.id);
                break;
        }
    }

    /**
     * Reçoit un ping d'un room server.
     *
     * @param {IRoomServerPing} server - Les données du ping.
     *
     * @private
     */

    private _receiveServerPing(server: IRoomServerPing)
    {
        if (server.reset)
        {
            // On supprime les données connues sur le serveur
            this._roomServers.delete(server.publicUrl);
        }

        const roomServer = this._roomServers.get(server.publicUrl);

        if (roomServer)
        {
            // Le serveur est déjà enregistré, on met à jour le nombre de clients
            roomServer.clientCount = server.clientCount;

            // On actualise l'heure du dernier ping
            roomServer.lastPing = Date.now();
        }
        else
        {
            // Le serveur est nouveau, on l'ajoute à la liste
            this._addNewServer({
                publicUrl: server.publicUrl,
                clientCount: server.clientCount,
                rooms: {},
                lastPing: Date.now()
            });
        }
    }

    /**
     * Ajoute un room server à la liste.
     *
     * @param {IRoomServer} server - Le room server à ajouter.
     *
     * @private
     */

    private _addNewServer(server: IRoomServer)
    {
        // On ajoute le serveur à la liste
        this._roomServers.set(server.publicUrl, server);

        // On notifie les listeners
        this.emit('newServer', server);

        // Puis on récupère les salons existants
        this._nats.request(`rooms.${server.publicUrl}`, null, { max: 1 }, (rooms: IRoomList) =>
        {
            // On ajoute les salons au serveur
            Object.values(rooms).forEach((room: IRoomSummary) =>
            {
                this._addNewRoom(server, room);
            });
        });
    }

    /**
     * Supprime un serveur de la liste.
     *
     * @param {IRoomServer} roomServer - Le room server à supprimer.
     *
     * @private
     */

    private _removeServer(roomServer: IRoomServer)
    {
        // On supprime les salons
        Object.keys(roomServer.rooms).forEach((roomId: string) =>
        {
            this._removeRoom(roomServer, roomId);
        });

        // On supprime le serveur de la liste
        this._roomServers.delete(roomServer.publicUrl);

        // On notifie les listeners
        this.emit('serverRemoved', roomServer);
    }

    /**
     * Supprime un room server de la liste, via son url publique, s'il existe.
     *
     * @param {string} publicUrl - L'url publique du room server.
     *
     * @private
     */

    private _removeServerByUrl(publicUrl: string)
    {
        const roomServer = this._roomServers.get(publicUrl);

        if (roomServer)
        {
            // Le room server existe, on le supprime
            this._removeServer(roomServer);
        }
    }

    /**
     * Ajoute un nouveau salon.
     *
     * @param {IRoomServer} roomServer - Le room server où ajouter le salon.
     * @param {IRoomSummary} room - Le salon à ajouter.
     *
     * @private
     */

    private _addNewRoom(roomServer: IRoomServer, room: IRoomSummary)
    {
        if (roomServer.rooms[room.id])
        {
            // Le salon existe déjà
            return;
        }

        // On ajoutera les clients dans un second temps
        const clients = room.clients;
        room.clients = {};

        roomServer.rooms[room.id] = room;

        // On notifie les listeners
        this.emit('newRoom', room);

        // Puis on ajoute les clients
        Object.values(clients).forEach((client: IClientSummary) =>
        {
            this._addNewClient(room, client);
        });
    }

    /**
     * Supprime un salon.
     *
     * @param {IRoomServer} roomServer - Le room server du salon.
     * @param {string} roomId - L'id du salon.
     */

    private _removeRoom(roomServer: IRoomServer, roomId: string)
    {
        const room = roomServer.rooms[roomId];

        if (!room)
        {
            // Le salon n'existe pas
            return;
        }

        // On supprime les clients du salon
        Object.keys(room.clients).forEach((clientId: string) =>
        {
            this._removeClient(room, clientId);
        });

        // On supprime le salon
        delete roomServer.rooms[roomId];

        // On notifie les listeners
        this.emit('roomRemoved', room);
    }

    /**
     * Ajoute un client dans un salon.
     *
     * @param {IRoomSummary} room - Le salon dans lequel ajouter le client.
     * @param {IClientSummary} client - Le client à ajouter.
     *
     * @private
     */

    private _addNewClient(room: IRoomSummary, client: IClientSummary)
    {
        if (room.clients[client.id])
        {
            // Le client existe déjà
            return;
        }

        room.clients[client.id] = client;

        // On notifie les listeners
        this.emit('roomJoined', room, client);
    }

    /**
     * Supprime un client d'un salon.
     *
     * @param {IRoomSummary} room - Le salon d'où supprimer le client.
     * @param {string} clientId - L'id du client à supprimer.
     *
     * @private
     */

    private _removeClient(room: IRoomSummary, clientId: string)
    {
        const client = room.clients[clientId];

        if (!client)
        {
            // Le client n'existe pas
            return;
        }

        // On notifie les listeners
        this.emit('roomLeft', room, client);

        // On supprime le client
        delete room.clients[clientId];
    }

    /**
     * Boucle de vérification des room servers.
     * Cette dernière vérifie si tous les room servers ont émis un ping
     * récemment. Le cas échéant, le serveur est supprimé de la liste et les
     * listeners sont notifiés.
     *
     * @private
     */

    private _serverCheckLoop()
    {
        const now = Date.now();

        this._roomServers.forEach((server: IRoomServer) =>
        {
            if (server.lastPing + this._serverTimeout < now)
            {
                // Le room server n'a plus émis de ping depuis un certain
                // temps, on le considère comme arrêté
                this._removeServer(server);
            }
        });
    }

    /**
     * Souscrit à un abonnement auprès du serveur NATS.
     *
     * @param {string} subject - Le nom de l'abonnement.
     * @param {Function} callback - Le callback à appeller lors de la réception
     *        d'un message.
     *
     * @private
     */

    private _subscribe(subject: string, callback: Function)
    {
        const subId = this._nats.subscribe(subject, (...args: any[]) =>
        {
            try
            {
                callback(...args);
            }
            catch (error)
            {
                // Erreur du callback
                console.error(`${error}`);
            }
        });

        this._subscriptions.push(subId);
    }
}
