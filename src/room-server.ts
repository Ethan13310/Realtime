// Copyright (c) 2019 Ethan Margaillan <contact@ethan.jp>.
// Licensed under the MIT Licence - https://raw.githubusercontent.com/Ethan13310/Realtime/master/LICENSE

import defaults = require('defaults');
import * as WebSocket from 'ws';
import * as jwt from 'jsonwebtoken';
import { Client } from './client';
import { EventEmitter } from 'events';
import { ITokenOptions } from './discovery';
import { Client as NatsClient } from 'nats';
import { IRoomOptions, IRoomSummary, Room } from './room';

/**
 * Représentation de la liste des salons d'un room server.
 *
 * @interface IRoomList
 */

export interface IRoomList
{
    /**
     * La liste des salons instanciés sur un serveur.
     */
    [roomId: string]: IRoomSummary
}

/**
 * Représentation d'un room server.
 *
 * @interface IRoomServer
 */

export interface IRoomServer
{
    /**
     * L'URL publique du serveur.
     */
    publicUrl: string;

    /**
     * Le nombre de clients connectés au serveur.
     */
    clientCount: number;

    /**
     * La liste des salons instanciés sur ce serveur.
     */
    rooms: IRoomList;

    /**
     * Le timestamp (millisecondes) du dernier ping du serveur.
     */
    lastPing: number;
}

/**
 * Représentation des données d'un ping envoyé par un room server.
 *
 * @interface IRoomServerPing
 */

export interface IRoomServerPing
{
    /**
     * L'URL publique du serveur.
     */
    publicUrl: string;

    /**
     * Le nombre de clients connectés au serveur.
     */
    clientCount: number;

    /**
     * Remise à zéro des données du serveur.
     * Cela est, par exemple, utilisé lors du démarrage du serveur.
     */
    reset?: boolean;
}

/**
 * Représentation des options d'initialisation d'un room server.
 *
 * @interface IRoomServerOptions
 */

export interface IRoomServerOptions
{
    /**
     * Activer la synchronisation des salons avec les serveurs de découverte.
     * Vaut 'true' par défaut.
     */
    syncRooms?: boolean;

    /**
     * Activer la synchronisation des clients avec les serveurs de découverte.
     * Vaut 'true' par défaut.
     * Si 'syncRooms' est définie à 'false', alors aucune synchronisation des
     * clients ne sera faite.
     */
    syncClients?: boolean;

    /**
     * Les options des salons.
     */
    roomOptions?: IRoomOptions;
}

/**
 * Classe représentant un room server.
 *
 * @class RoomServer
 */

export class RoomServer extends EventEmitter
{
    /**
     * L'url publique du serveur.
     */
    private readonly _publicUrl: string;

    /**
     * Le client NATS.
     */
    private readonly _nats: NatsClient;

    /**
     * Le serveur WebSocket.
     */
    private readonly _ws: WebSocket.Server;

    /**
     * Les options du serveur.
     */
    private readonly _options: IRoomServerOptions;

    /**
     * La clé de génération des JSON web tokens.
     */
    private readonly _tokenSecret: string = process.env.DISCOVERY_SECRET || 'defaultSecret';

    /**
     * Le nombre de clients connectés.
     */
    private _clientCount: number = 0;

    /**
     * La liste des salons hébergés par ce room server.
     *
     * Key: L'id du salon.
     * Value: Le salon.
     */
    private readonly _rooms = new Map<string, Room>();

    /**
     * La boucle d'envoi de pings aux serveurs de discovery.
     */
    private readonly _pingInterval: NodeJS.Timeout;

    /**
     * Constructeur du room server.
     *
     * @param {string} publicUrl - L'url publique du serveur.
     * @param {NatsClient} nats - Le client NATS.
     * @param {WebSocket.Server} ws - Le serveur WebSocket.
     * @param {IRoomServerOptions} [options] - Les options du serveur.
     */

    public constructor(publicUrl: string, nats: NatsClient, ws: WebSocket.Server, options?: IRoomServerOptions)
    {
        super();

        // Url publique du serveur
        this._publicUrl = publicUrl;

        // Client NATS
        this._nats = nats;

        // Serveur WebSocket
        this._ws = ws;

        // Options du serveur
        this._options = defaults(options, {
            syncRooms: true,
            syncClients: true
        });

        // Options des salons
        this._options.roomOptions = defaults(this._options.roomOptions, {
            pingInterval: null,
            missedPingsLimit: 1,
            keepAlive: false
        });

        // On notifie les serveurs de discovery
        this._sendPing(true);

        this._pingInterval = setInterval(() => this._sendPing(), 1000);

        // Connexion d'un client
        this._ws.on('connection', (socket: WebSocket) =>
        {
            this._handleClient(socket);
        });

        // Réception d'un broadcast
        this._nats.subscribe('broadcast', (message: any) =>
        {
            this.emit('broadcast', message);
        });

        // Envoi des salons à un serveur de discovery
        this._nats.subscribe(`rooms.${this._publicUrl}`, (message: null, replyTo: string) =>
        {
            this._sendRooms(replyTo);
        });
    }

    /**
     * Arrête le room server.
     *
     * @param {Function} [callback] - Un callback optionnel à appeller lorsque
     *        le room server se sera arrêté.
     */

    public stop(callback?: Function)
    {
        this._ws.close(() =>
        {
            // On supprime les salons persistants restants
            this._rooms.forEach((room: Room) =>
            {
                this._removeRoom(room);
            });

            // On cesse d'emettre des pings aux serveurs de discovery
            clearInterval(this._pingInterval);

            // On notifie les serveurs de discovery
            this._nats.publish('rs.stop', this._publicUrl);

            this._ws.removeAllListeners();

            // On informe les listeners
            this.emit('stop');

            if (typeof callback === 'function')
            {
                // Callback optionnel
                callback();
            }
        });
    }

    /**
     * Retourne le nombre de clients connectés à ce room server.
     *
     * @returns {number}
     */

    public get clientCount(): number
    {
        return this._clientCount;
    }

    /**
     * Retourne un salon, ou 'null' s'il n'existe pas.
     *
     * @param {string} roomId - L'id du salon à retourner.
     *
     * @returns {Room | null}
     */

    public getRoom(roomId: string): Room | null
    {
        return this._rooms.get(roomId) || null;
    }

    /**
     * Gère la connexion d'un client au WebSocket.
     *
     * @param {WebSocket} socket - Le socket du client.
     *
     * @private
     */

    private _handleClient(socket: WebSocket)
    {
        socket.once('message', (data: string) =>
        {
            try
            {
                // Authentification du client
                const token = this._authenticate(data);

                // Connexion du client
                this._connectClient(socket, token);
            }
            catch (error)
            {
                // Echec de la connexion
                socket.send(JSON.stringify({
                    error: 'Authentication Failed',
                    message: error.message
                }));

                socket.close();
            }
        });
    }

    /**
     * Connecte un nouveau client à un salon.
     *
     * @param {WebSocket} socket - Le socket du client.
     * @param {ITokenOptions} token - Les données du token de connexion.
     *
     * @private
     */

    private _connectClient(socket: WebSocket, token: ITokenOptions)
    {
        const room = this._getRoom(token.roomId, token.roomProperties);

        // On vérifie que le client n'est pas déjà connecté au salon
        if (room.hasClient(token.clientId))
        {
            throw new Error('You are already connected to this room.');
        }

        const client = new Client(socket, token.clientId, token.clientProperties);

        // On connecte le client au salon
        room.join(client);

        this._clientCount++;

        // Déconnexion du client
        socket.once('close', () =>
        {
            this._disconnectClient(client, room);
        });
    }

    /**
     * Déconnecte un client.
     *
     * @param {Client} client - Le client à déconnecter.
     * @param {Room} room - Le salon auquel le client est connecté.
     *
     * @private
     */

    private _disconnectClient(client: Client, room: Room)
    {
        // On déconnecte le client du salon
        room.leave(client);

        this._clientCount--;

        if (room.isEmpty && !room.keepAlive)
        {
            // Le salon est désormais vide et n'est pas persistant, on
            // le supprime
            this._removeRoom(room);
        }
    }

    /**
     * Authentifie le client. Lève une exception si l'authentification échoue.
     *
     * @param {string} token - Le JSON web token.
     *
     * @returns {ITokenOptions} Les données du JSON web token.
     * @private
     */

    private _authenticate(token: string): ITokenOptions
    {
        let data: ITokenOptions;

        try
        {
            // On décode le JSON web token
            data = <ITokenOptions> jwt.verify(token, this._tokenSecret, {
                subject: 'joinRoom'
            });
        }
        catch (error)
        {
            throw new Error('The authentication token is invalid.');
        }

        if (data.publicUrl !== this._publicUrl)
        {
            // Le token est pour un autre room server
            throw new Error('The authentication token is intended for another room server.');
        }

        return data;
    }

    /**
     * Récupère un salon existant via on id ou le crée s'il n'existe pas.
     *
     * @param {string} roomId - L'id du salon.
     * @param {*} [properties] - Les propriétés à assigner au salon dans le
     *        cas où il n'existerai pas encore.
     *
     * @returns {Room}
     * @private
     */

    private _getRoom(roomId: string, properties?: any): Room
    {
        const room = this._rooms.get(roomId);

        if (room)
        {
            // Le salon existe
            return room;
        }

        // Le salon n'existe pas, on le crée
        return this._createRoom(roomId, properties);
    }

    /**
     * Crée un nouveau salon.
     *
     * @param {string} roomId - L'id du salon.
     * @param {*} [properties] - Les propriétés du salon.
     *
     * @returns {Room}
     * @private
     */

    private _createRoom(roomId: string, properties?: any): Room
    {
        const room = new Room(this._publicUrl, roomId, properties, this._options.roomOptions);

        // On notifie les listeners
        this.emit('newRoom', room);

        // Synchronisation des salons avec les serveurs de discovery
        if (this._options.syncRooms)
        {
            this._notify(room, 'newRoom', {
                properties: room.properties
            });

            // Synchronisation des clients avec les serveurs de discovery
            if (this._options.syncClients)
            {
                // Un client a rejoint le salon
                room.on('joined', (client: Client) =>
                {
                    this._notify(room, 'roomJoined', {
                        client: client.summary
                    });
                });

                // Un client a quitté le salon
                room.on('left', (client: Client) =>
                {
                    this._notify(room, 'roomLeft', {
                        client: client.summary
                    });
                });
            }
        }

        // On ajoute le salon à la liste
        this._rooms.set(roomId, room);

        // Suppression forcée du salon
        room.on('terminated', () =>
        {
            this._removeRoom(room);
        });

        return room;
    }

    /**
     * Supprime un salon existant.
     *
     * @param {Room} room - Le salon à supprimer.
     *
     * @private
     */

    private _removeRoom(room: Room)
    {
        if (!this._rooms.has(room.id))
        {
            // Le salon n'existe pas
            return;
        }

        room.clearPingInterval();

        // On notifie les listeners
        this.emit('roomRemoved', room);

        if (this._options.syncRooms)
        {
            // On notifie les serveurs de discovery
            this._notify(room, 'roomRemoved');
        }

        room.removeAllListeners();

        // On supprime le salon de la liste
        this._rooms.delete(room.id);
    }

    /**
     * Envoie la liste des salons à un serveur de discovery.
     *
     * @param {string} replyTo - Le serveur de discovery auquel envoyer
     *        les salons.
     *
     * @private
     */

    private _sendRooms(replyTo: string)
    {
        const list: IRoomList = {};

        if (this._options.syncRooms)
        {
            this._rooms.forEach((room: Room) =>
            {
                // On récupère le résumé des salons, avec ou sans les clients en
                // fonction des paramètres du room server
                const summary = room.summary;

                if (this._options.syncClients)
                {
                    summary.clients = room.clients;
                }

                list[room.id] = summary;
            });
        }

        this._nats.publish(replyTo, list);
    }

    /**
     * Notifie les serveurs de discovery d'un événement relatif à un salon:
     * - Création/suppression d'un salon.
     * - Arrivée/départ d'un client.
     *
     * @param {Room} room - Le salon dont il est sujet.
     * @param {string} subject - L'événement en question.
     * @param {object} [payload] - Les données supplémentaires de l'événement.
     *
     * @private
     */

    private _notify(room: Room, subject: string, payload: object = {})
    {
        this._nats.publish('rs.event', {
            ...payload,
            publicUrl: this._publicUrl,
            roomId: room.id,
            subject: subject
        });
    }

    /**
     * Envoie un ping aux serveurs de discovery.
     *
     * @param {boolean} [reset] - Forcer les serveurs de discovery à considérer
     *        ce room server comme étant nouveau.
     *
     * @private
     */

    private _sendPing(reset: boolean = false)
    {
        // Envoi du ping
        this._nats.publish('ping', <IRoomServerPing> {
            publicUrl: this._publicUrl,
            clientCount: this.clientCount,
            reset: reset || undefined
        });
    }
}
