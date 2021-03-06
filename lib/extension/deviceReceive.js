const settings = require('../util/settings');
const logger = require('../util/logger');
const utils = require('../util/utils');

const dontCacheProperties = [
    'action', 'button', 'button_left', 'button_right', 'click', 'forgotten', 'keyerror',
    'step_size', 'transition_time', 'action_color_temperature', 'action_color',
    'action_group',
];

/**
 * This extensions handles messages received from devices.
 */
class DeviceReceive {
    constructor(zigbee, mqtt, state, publishEntityState) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.publishEntityState = publishEntityState;
        this.coordinator = null;
        this.elapsed = {};
    }

    onZigbeeStarted() {
        this.coordinator = this.zigbee.getCoordinator().device.ieeeAddr;
    }

    onZigbeeMessage(message, device, mappedDevice) {
        if (message.type == 'devInterview') {
            if (!settings.getDevice(message.data)) {
                logger.info('Connecting with device...');
                this.mqtt.log('pairing', 'connecting with device');
            }

            return;
        }

        if (message.type == 'devIncoming') {
            logger.info('Device incoming...');
            this.mqtt.log('pairing', 'device incoming');
        }

        if (!device) {
            logger.warn('Message without device!');
            return;
        }

        if (device.ieeeAddr === this.coordinator) {
            logger.debug('Ignoring message from coordinator');
            return;
        }

        // Check if this is a new device.
        if (!settings.getDevice(device.ieeeAddr)) {
            logger.info(`New device '${device.modelId}' with address ${device.ieeeAddr} connected!`);
            settings.addDevice(device.ieeeAddr);
            this.mqtt.log('device_connected', device.ieeeAddr, {modelID: device.modelId});
        }

        if (!mappedDevice) {
            logger.warn(`Device with modelID '${device.modelId}' is not supported.`);
            logger.warn(`Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html`);
            return;
        }

        // After this point we cant handle message withoud cid or cmdId anymore.
        if (!message.data || (!message.data.cid && !message.data.cmdId)) {
            return;
        }

        // Find a conveter for this message.
        const cid = message.data.cid;
        const cmdId = message.data.cmdId;
        const converters = mappedDevice.fromZigbee.filter((c) => {
            if (cid) {
                // readRsp messages have the same structure as attReport messages.
                // search for attReport converters on readRsp.
                const search = message.type === 'readRsp' ? 'attReport' : message.type;
                return c.cid === cid && c.type === search;
            } else if (cmdId) {
                return c.cmd === cmdId;
            }

            return false;
        });

        // Check if there is an available converter
        if (!converters.length) {
            if (cid) {
                // Don't log readRsp messages, they are not interesting most of the time.
                if (message.type === 'readRsp') {
                    return;
                }

                logger.warn(
                    `No converter available for '${mappedDevice.model}' with cid '${cid}', ` +
                    `type '${message.type}' and data '${JSON.stringify(message.data)}'`
                );
            } else if (cmdId) {
                logger.warn(
                    `No converter available for '${mappedDevice.model}' with cmd '${cmdId}' ` +
                    `and data '${JSON.stringify(message.data)}'`
                );
            }

            logger.warn(`Please see: https://www.zigbee2mqtt.io/how_tos/how_to_support_new_devices.html.`);
            return;
        }

        // Convert this Zigbee message to a MQTT message.
        // Get payload for the message.
        // - If a payload is returned publish it to the MQTT broker
        // - If NO payload is returned do nothing. This is for non-standard behaviour
        //   for e.g. click switches where we need to count number of clicks and detect long presses.
        const publish = (payload) => {
            // Don't cache messages with following properties:
            let cache = true;
            dontCacheProperties.forEach((property) => {
                if (payload.hasOwnProperty(property)) {
                    cache = false;
                }
            });

            // Add device linkquality.
            if (message.hasOwnProperty('linkquality')) {
                payload.linkquality = message.linkquality;
            }

            // Add last seen timestamp
            const now = Date.now();
            switch (settings.get().advanced.last_seen) {
            case 'ISO_8601':
                payload.last_seen = new Date(now).toISOString();
                break;
            case 'ISO_8601_local':
                payload.last_seen = utils.toLocalISOString(new Date(now));
                break;
            case 'epoch':
                payload.last_seen = now;
                break;
            }

            if (settings.get().advanced.elapsed) {
                if (this.elapsed[device.ieeeAddr]) {
                    payload.elapsed = now - this.elapsed[device.ieeeAddr];
                }

                this.elapsed[device.ieeeAddr] = now;
            }

            this.publishEntityState(device.ieeeAddr, payload, cache);
        };

        let payload = {};
        converters.forEach((converter) => {
            const options = {...settings.get().device_options, ...settings.getDevice(device.ieeeAddr)};
            const converted = converter.convert(mappedDevice, message, publish, options);

            if (converted) {
                payload = {...payload, ...converted};
            }
        });

        if (Object.keys(payload).length) {
            publish(payload);
        }
    }
}

module.exports = DeviceReceive;
